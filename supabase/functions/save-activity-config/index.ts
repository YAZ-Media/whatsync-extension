import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  DEFAULT_ACTIVITY_CONFIG,
  getExternalSupabaseCredentials,
  loadActivityConfig,
  normalizeActivityConfig,
  saveActivityConfigToDb,
} from "../_shared/activityConfig.ts";
import { authenticateRequest, fetchUserProfileRole } from "../_shared/auth.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, data } = await req.json();

    if (action === 'get') {
      const config = await loadActivityConfig();
      const source = getExternalSupabaseCredentials() ? 'database' : 'defaults';

      return new Response(JSON.stringify({
        ...config,
        source,
        configured: source === 'database',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'save') {
      // This config decides which table retention purges DELETE from — only an
      // authenticated Owner/Admin may change it (it was previously open to
      // anyone with the public anon key).
      const auth = await authenticateRequest(req);
      if (!auth.ok) {
        return new Response(JSON.stringify({ success: false, error: auth.error }), {
          status: auth.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const profile = await fetchUserProfileRole(auth.userId);
      if (!profile || !['Owner', 'Admin'].includes(String(profile.role))) {
        return new Response(JSON.stringify({ success: false, error: 'Only Owners and Admins can change the activity configuration' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { tableName, userColumn, timestampColumn } = data || {};

      if (!tableName || !userColumn) {
        throw new Error('Table name and user ID column are required');
      }

      const saved = await saveActivityConfigToDb(
        normalizeActivityConfig({
          tableName,
          userColumn,
          timestampColumn: timestampColumn || DEFAULT_ACTIVITY_CONFIG.timestampColumn,
        })
      );

      return new Response(JSON.stringify({
        success: true,
        message: 'Activity table configuration saved successfully.',
        config: saved,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in save-activity-config:', errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
