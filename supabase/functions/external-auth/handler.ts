import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyInviteToken } from "../_shared/invites.ts";
import { assertSeatCapacity, consumesPaidSeat } from "../_shared/seats.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export async function handleExternalAuth(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const externalUrl = Deno.env.get("EXTERNAL_SUPABASE_URL");
    const externalServiceKey = Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY");

    if (!externalUrl || !externalServiceKey) {
      return new Response(
        JSON.stringify({ error: "External Supabase not configured" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const externalSupabase = createClient(externalUrl, externalServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { action, email, password, firstName, lastName, company, redirectTo, emailRedirectTo, inviteToken, refreshToken, token_hash, tokenHash, type } = await req.json();

    if (action === "resendConfirmation") {
      const normalizedEmail = String(email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return new Response(
          JSON.stringify({ error: "Enter a valid email address." }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let confirmationUrl = "https://whatsync.io/auth/callback";
      try {
        const requested = new URL(String(emailRedirectTo || confirmationUrl));
        const allowedProduction = requested.protocol === "https:" && ["whatsync.io", "www.whatsync.io"].includes(requested.hostname);
        const allowedLocal = requested.protocol === "http:" && ["localhost", "127.0.0.1"].includes(requested.hostname);
        if (allowedProduction || allowedLocal) confirmationUrl = requested.toString();
      } catch {
        // Use the production callback for malformed or untrusted redirect input.
      }

      const { error } = await externalSupabase.auth.resend({
        type: "signup",
        email: normalizedEmail,
        options: { emailRedirectTo: confirmationUrl },
      });
      if (error) {
        const rateLimited = /rate|seconds|minute/i.test(error.message);
        return new Response(
          JSON.stringify({ error: rateLimited ? "Please wait a minute before requesting another email." : "We couldn’t send a new confirmation email. Please retry." }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Keep the response generic so this endpoint cannot be used to discover accounts.
      return new Response(
        JSON.stringify({ success: true, message: "If this account is awaiting confirmation, a fresh link has been sent." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "signIn") {
      const { data, error } = await externalSupabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Fetch profile data from user_profiles table
      const { data: profile } = await externalSupabase
        .from("user_profiles")
        .select("user_id, email, first_name, last_name, company")
        .eq("user_id", data.user.id)
        .maybeSingle();

      return new Response(
        JSON.stringify({
          user: data.user,
          session: data.session,
          profile,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "signUp") {
      // Validate the invite BEFORE creating the auth user, so an invalid link
      // never leaves an account without its proper profile.
      // Role and organization are only honored from a server-signed invite
      // token whose email matches the signup email — raw role/organizationId
      // from the request body used to be trusted, which let anyone join any
      // organization as Owner.
      let profileRole = 'Owner'; // a fresh signup owns their own workspace
      let profileOrg: string | null = null; // defaults to the new user id below
      let invitedBy: string | null = null;

      if (inviteToken) {
        const invite = await verifyInviteToken(String(inviteToken));
        if (!invite) {
          return new Response(
            JSON.stringify({ error: "This invitation link is invalid or has expired. Ask your admin to send a new one." }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        if (invite.email !== String(email ?? '').trim().toLowerCase()) {
          return new Response(
            JSON.stringify({ error: "This invitation was issued for a different email address." }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        profileRole = invite.role;
        profileOrg = invite.organizationId;
        invitedBy = invite.invitedBy;
      }

      // Check if email already exists
      const { data: existingUser } = await externalSupabase
        .from("user_profiles")
        .select("email")
        .eq("email", email)
        .maybeSingle();

      if (existingUser) {
        return new Response(
          JSON.stringify({ error: "EMAIL_ALREADY_REGISTERED" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Re-check at acceptance time. Several valid links may be opened at once,
      // so checking only when an invitation is sent cannot enforce plan quantity.
      if (inviteToken && profileOrg && invitedBy && consumesPaidSeat(profileRole, 'Active')) {
        try {
          await assertSeatCapacity(profileOrg, invitedBy);
        } catch (seatError) {
          return new Response(
            JSON.stringify({ error: seatError instanceof Error ? seatError.message : "No paid seat is available." }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      const { data, error } = await externalSupabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: emailRedirectTo || redirectTo || undefined,
          data: {
            first_name: firstName,
            last_name: lastName,
            company: company,
          },
        },
      });

      if (error) {
        if (error.message.includes("already registered")) {
          return new Response(
            JSON.stringify({ error: "EMAIL_ALREADY_REGISTERED" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Create the profile with the invite-validated (or default) role/org.
      if (data.user) {
        const profileData: Record<string, unknown> = {
          user_id: data.user.id,
          email: email,
          first_name: firstName,
          last_name: lastName,
          company: company,
          status: 'Active',
          role: profileRole,
          organization_id: profileOrg || data.user.id,
          invited_by: invitedBy,
        };

        // signUp can attach a user session to its client even when persistence
        // is off. Use a fresh server client for privileged profile fields.
        const profileDatabase = createClient(externalUrl, externalServiceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { error: profileError } = await profileDatabase.from("user_profiles").insert(profileData);
        if (profileError) {
          console.error("Signup profile creation failed:", profileError.code);
          return new Response(JSON.stringify({error: "Your login was created, but workspace setup failed. Contact support before continuing."}),
            {status: 500, headers: {...corsHeaders, "Content-Type": "application/json"}});
        }
      }

      const requiresConfirmation = data.user && !data.session;

      return new Response(
        JSON.stringify({
          user: data.user,
          session: data.session,
          requiresConfirmation,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "signOut") {
      // For sign out, we just confirm it's done - the client handles the session
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "refreshSession") {
      if (!refreshToken) {
        return new Response(
          JSON.stringify({ error: "Missing refresh token" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data, error } = await externalSupabase.auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session) {
        return new Response(
          JSON.stringify({ error: error?.message || "Unable to refresh session" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ user: data.user, session: data.session }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "getSession") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(
          JSON.stringify({ user: null, session: null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await externalSupabase.auth.getUser(token);

      if (error || !user) {
        return new Response(
          JSON.stringify({ user: null, session: null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Fetch profile from user_profiles table
      const { data: profile } = await externalSupabase
        .from("user_profiles")
        .select("user_id, email, first_name, last_name, company")
        .eq("user_id", user.id)
        .maybeSingle();

      return new Response(
        JSON.stringify({ user, profile }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "resetPassword") {
      const finalRedirect =
        redirectTo ||
        req.headers.get("x-redirect-to") ||
        `${req.headers.get("origin") || "https://whatsync.io"}/reset-password`;

      const { error } = await externalSupabase.auth.resetPasswordForEmail(email, {
        redirectTo: finalRedirect,
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "verifyRecoveryToken") {
      const recoveryTokenHash = token_hash || tokenHash;
      if (!recoveryTokenHash || type !== "recovery") {
        return new Response(
          JSON.stringify({ error: "Invalid reset link" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data, error } = await externalSupabase.auth.verifyOtp({
        token_hash: recoveryTokenHash,
        type: "recovery",
      });

      if (error || !data.session?.access_token) {
        return new Response(
          JSON.stringify({ error: error?.message || "Invalid or expired reset link" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ user: data.user, session: data.session }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "updatePassword") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "Not authenticated" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: userErr } = await externalSupabase.auth.getUser(token);
      if (userErr || !user) {
        return new Response(
          JSON.stringify({ error: userErr?.message || "Invalid or expired token" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { error } = await externalSupabase.auth.admin.updateUserById(user.id, { password });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("External auth error:", error);
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
