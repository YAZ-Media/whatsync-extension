import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticateRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(msg: string) {
  return ok({ error: msg });
}

async function getUserProfileRole(
  ext: ReturnType<typeof createClient>,
  userId: string
): Promise<{ role: string; status: string } | null> {
  const res = await ext
    .from("user_profiles")
    .select("role,status")
    .eq("user_id", userId)
    .maybeSingle();

  if (res.error || !res.data) {
    return null;
  }

  return {
    role: String(res.data.role || "Member"),
    status: String(res.data.status || "Active"),
  };
}

function canManageBilling(role: string, status: string): boolean {
  return status === "Active" && (role === "Owner" || role === "Billing");
}

async function assertBillingManage(ext: ReturnType<typeof createClient>, userId: string) {
  const profile = await getUserProfileRole(ext, userId);
  if (!profile || !canManageBilling(profile.role, profile.status)) {
    throw new Error("You do not have permission to manage billing");
  }
}

async function assertBillingView(ext: ReturnType<typeof createClient>, userId: string) {
  const profile = await getUserProfileRole(ext, userId);
  if (!profile || profile.status !== "Active") {
    throw new Error("Your account is not active");
  }
  const allowed = ["Owner", "Admin", "Billing", "Read-only"];
  if (!allowed.includes(profile.role)) {
    throw new Error("You do not have permission to view billing");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const externalUrl = Deno.env.get("EXTERNAL_SUPABASE_URL");
    const externalServiceKey = Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY");

    if (!externalUrl || !externalServiceKey) {
      return err("External Supabase not configured");
    }

    const ext = createClient(externalUrl, externalServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { action, data } = await req.json();
    console.log(`Billing action: ${action}`, JSON.stringify(data));

    // Every billing action operates on data.userId — require a valid session
    // whose subject matches it. (These endpoints were previously reachable with
    // just the public anon key, exposing invoices, saved cards, and plan
    // changes for any userId.)
    const auth = await authenticateRequest(req, (data?.userId as string) || null);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    switch (action) {
      // ── GET BILLING DATA ──────────────────────────────────────────
      case "getBillingData": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");
        await assertBillingView(ext, userId);

        const [subRes, usageRes, invRes, pmRes] = await Promise.all([
          ext.from("subscriptions").select("*").eq("user_id", userId).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle(),
          ext.from("usage_tracking").select("*").eq("user_id", userId).order("period_start", { ascending: false }).limit(1).maybeSingle(),
          ext.from("invoices").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
          ext.from("payment_methods").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        ]);

        if (subRes.error) console.error("subscriptions error:", subRes.error);
        if (usageRes.error) console.error("usage_tracking error:", usageRes.error);
        if (invRes.error) console.error("invoices error:", invRes.error);
        if (pmRes.error) console.error("payment_methods error:", pmRes.error);

        return ok({
          subscription: subRes.data,
          usage: usageRes.data,
          invoices: invRes.data || [],
          paymentMethods: pmRes.data || [],
        });
      }

      // ── SAVE PAYMENT METHOD ───────────────────────────────────────
      case "savePaymentMethod": {
        const { userId, cardNumber, expMonth, expYear, cardholderName, isDefault } = data || {};
        if (!userId || !cardNumber || !expMonth || !expYear || !cardholderName) {
          throw new Error("Missing required card fields");
        }
        await assertBillingManage(ext, userId);

        // Determine card brand from number
        const num = cardNumber.replace(/\s/g, "");
        let brand = "Unknown";
        if (num.startsWith("4")) brand = "Visa";
        else if (/^5[1-5]/.test(num)) brand = "Mastercard";
        else if (/^3[47]/.test(num)) brand = "Amex";
        else if (/^6(?:011|5)/.test(num)) brand = "Discover";

        const lastFour = num.slice(-4);

        // If setting as default, unset others
        if (isDefault) {
          await ext.from("payment_methods").update({ is_default: false }).eq("user_id", userId);
        }

        const insertRes = await ext.from("payment_methods").insert({
          user_id: userId,
          card_brand: brand,
          last_four: lastFour,
          exp_month: parseInt(expMonth),
          exp_year: parseInt(expYear),
          cardholder_name: cardholderName,
          is_default: isDefault ?? true,
        }).select().single();

        if (insertRes.error) {
          console.error("Save payment method error:", insertRes.error);
          throw new Error("Failed to save payment method. Please ensure the payment_methods table exists.");
        }

        return ok({ success: true, paymentMethod: insertRes.data });
      }

      // ── GET PAYMENT METHODS ───────────────────────────────────────
      case "getPaymentMethods": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");
        await assertBillingView(ext, userId);

        const res = await ext.from("payment_methods").select("*").eq("user_id", userId).order("created_at", { ascending: false });
        if (res.error) {
          console.error("Get payment methods error:", res.error);
          return ok({ paymentMethods: [] });
        }
        return ok({ paymentMethods: res.data || [] });
      }

      // ── DELETE PAYMENT METHOD ─────────────────────────────────────
      case "deletePaymentMethod": {
        const { userId, paymentMethodId } = data || {};
        if (!userId || !paymentMethodId) throw new Error("userId and paymentMethodId required");
        await assertBillingManage(ext, userId);

        const delRes = await ext.from("payment_methods").delete().eq("id", paymentMethodId).eq("user_id", userId);
        if (delRes.error) {
          console.error("Delete payment method error:", delRes.error);
          throw new Error("Failed to delete payment method");
        }
        return ok({ success: true });
      }

      // ── SET DEFAULT PAYMENT METHOD ────────────────────────────────
      case "setDefaultPaymentMethod": {
        const { userId, paymentMethodId } = data || {};
        if (!userId || !paymentMethodId) throw new Error("userId and paymentMethodId required");
        await assertBillingManage(ext, userId);

        await ext.from("payment_methods").update({ is_default: false }).eq("user_id", userId);
        await ext.from("payment_methods").update({ is_default: true }).eq("id", paymentMethodId).eq("user_id", userId);
        return ok({ success: true });
      }

      // ── PROCESS PAYMENT & CHANGE PLAN ─────────────────────────────
      case "processPayment": {
        const { userId, planName, price, limits, paymentMethodId } = data || {};
        if (!userId || !planName) throw new Error("userId and planName are required");
        await assertBillingManage(ext, userId);

        // Verify payment method exists
        if (paymentMethodId) {
          const pmCheck = await ext.from("payment_methods").select("id, last_four, card_brand").eq("id", paymentMethodId).eq("user_id", userId).single();
          if (pmCheck.error) throw new Error("Payment method not found");
        }

        // Simulate payment processing delay
        await new Promise(r => setTimeout(r, 800));

        // Deactivate current subscription
        await ext.from("subscriptions").update({ status: "canceled" }).eq("user_id", userId).eq("status", "active");

        const now = new Date();
        const nextBilling = new Date(now);
        nextBilling.setMonth(nextBilling.getMonth() + 1);

        // Progressive insert for subscription
        const payloads = [
          {
            user_id: userId,
            plan_name: planName,
            price_monthly: price,
            status: "active",
            current_period_start: now.toISOString(),
            current_period_end: nextBilling.toISOString(),
            max_contacts: limits?.max_contacts ?? 500,
            max_api_calls: limits?.max_api_calls ?? 10000,
            max_team_members: limits?.max_team_members ?? 1,
            max_custom_fields: limits?.max_custom_fields ?? 5,
            max_templates: limits?.max_templates ?? 10,
            max_automations: limits?.max_automations ?? 0,
          },
          {
            user_id: userId,
            plan_name: planName,
            price_monthly: price,
            status: "active",
            current_period_start: now.toISOString(),
            current_period_end: nextBilling.toISOString(),
          },
          {
            user_id: userId,
            plan_name: planName,
            status: "active",
          },
        ];

        let newSub: Record<string, unknown> | null = null;
        for (const payload of payloads) {
          const result = await ext.from("subscriptions").insert(payload).select().single();
          if (!result.error) { newSub = result.data; break; }
          console.log("Insert attempt failed:", result.error.message, "- trying simpler payload");
          if (!result.error.message?.includes("column") && !result.error.message?.includes("PGRST")) {
            throw new Error(result.error.message);
          }
        }

        if (!newSub) throw new Error("Could not create subscription – table schema mismatch");

        // Generate invoice
        const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
        let invoiceData: Record<string, unknown> | null = null;

        const invoicePayloads = [
          {
            user_id: userId,
            amount: price,
            plan_name: planName,
            status: "paid",
            description: `${planName} Plan – Monthly Subscription`,
            invoice_number: invoiceNumber,
            period_start: now.toISOString(),
            period_end: nextBilling.toISOString(),
          },
          {
            user_id: userId,
            amount: price,
            plan_name: planName,
            status: "paid",
            invoice_number: invoiceNumber,
            period_start: now.toISOString(),
            period_end: nextBilling.toISOString(),
          },
          {
            user_id: userId,
            amount: price,
            plan_name: planName,
            invoice_number: invoiceNumber,
            period_start: now.toISOString(),
            period_end: nextBilling.toISOString(),
          },
        ];

        for (const payload of invoicePayloads) {
          const result = await ext.from("invoices").insert(payload).select().single();
          if (!result.error) {
            invoiceData = result.data;
            break;
          }
          console.log("Invoice insert attempt failed:", result.error.message);
        }

        if (!invoiceData) {
          console.error("Invoice creation failed after all payload attempts");
        }

        return ok({
          success: true,
          subscription: newSub,
          invoice: invoiceData,
          message: `${planName} plan activated successfully`,
        });
      }

      // ── LEGACY: changePlan (kept for backward compat) ─────────────
      case "changePlan": {
        const { userId, planName, price, limits } = data || {};
        if (!userId || !planName) throw new Error("userId and planName are required");
        await assertBillingManage(ext, userId);

        await ext.from("subscriptions").update({ status: "canceled" }).eq("user_id", userId).eq("status", "active");

        const now = new Date();
        const nextBilling = new Date(now);
        nextBilling.setMonth(nextBilling.getMonth() + 1);

        const payloads = [
          { user_id: userId, plan_name: planName, price_monthly: price, status: "active", current_period_start: now.toISOString(), current_period_end: nextBilling.toISOString(), max_contacts: limits?.max_contacts ?? 500, max_api_calls: limits?.max_api_calls ?? 10000, max_team_members: limits?.max_team_members ?? 1, max_custom_fields: limits?.max_custom_fields ?? 5, max_templates: limits?.max_templates ?? 10, max_automations: limits?.max_automations ?? 0 },
          { user_id: userId, plan_name: planName, price_monthly: price, status: "active", current_period_start: now.toISOString(), current_period_end: nextBilling.toISOString() },
          { user_id: userId, plan_name: planName, status: "active" },
        ];

        let newSub: Record<string, unknown> | null = null;
        for (const payload of payloads) {
          const result = await ext.from("subscriptions").insert(payload).select().single();
          if (!result.error) { newSub = result.data; break; }
          console.log("Insert attempt failed:", result.error.message);
          if (!result.error.message?.includes("column") && !result.error.message?.includes("PGRST")) throw new Error(result.error.message);
        }
        if (!newSub) throw new Error("Could not create subscription");

        try {
          const legacyInvoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
          const legacyInvoicePayloads = [
            {
              user_id: userId,
              amount: price,
              plan_name: planName,
              status: "paid",
              description: `${planName} Plan – Monthly`,
              invoice_number: legacyInvoiceNumber,
              period_start: now.toISOString(),
              period_end: nextBilling.toISOString(),
            },
            {
              user_id: userId,
              amount: price,
              plan_name: planName,
              status: "paid",
              invoice_number: legacyInvoiceNumber,
              period_start: now.toISOString(),
              period_end: nextBilling.toISOString(),
            },
            {
              user_id: userId,
              amount: price,
              plan_name: planName,
              invoice_number: legacyInvoiceNumber,
              period_start: now.toISOString(),
              period_end: nextBilling.toISOString(),
            },
          ];

          for (const payload of legacyInvoicePayloads) {
            const invRes = await ext.from("invoices").insert(payload).select().single();
            if (!invRes.error) break;
            console.error("Legacy invoice insert failed:", invRes.error.message);
          }
        } catch (invErr) { console.error("Invoice creation failed:", invErr); }

        return ok({ success: true, subscription: newSub });
      }

      default:
        throw new Error(`Unknown billing action: ${action}`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Billing function error:", msg);
    return err(msg);
  }
});
