// supabase/functions/grade-sheet/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    estimated_correct: { type: "integer" },
    note: { type: "string" },
  },
  required: ["estimated_correct", "note"],
  additionalProperties: false,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const { sheet_id } = await req.json();
    if (!sheet_id) {
      return new Response(JSON.stringify({ error: "sheet_id required" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const sb = createClient(SB_URL, SB_SERVICE_KEY);

    const { data: sheet, error: fetchErr } = await sb
      .from("sheets")
      .select("*")
      .eq("id", sheet_id)
      .single();
    if (fetchErr || !sheet) {
      return new Response(JSON.stringify({ error: "sheet not found" }), {
        status: 404,
        headers: corsHeaders(),
      });
    }
    if (!sheet.photo_url) {
      return new Response(JSON.stringify({ error: "no photo uploaded yet" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const { data: pub } = sb.storage.from("sheet-photos").getPublicUrl(sheet.photo_url);
    const photoResp = await fetch(pub.publicUrl);
    if (!photoResp.ok) {
      return new Response(JSON.stringify({ error: "could not fetch photo" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
    const photoBuf = await photoResp.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(photoBuf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const photoB64 = btoa(binary);
    const mediaType = photoResp.headers.get("content-type") || "image/jpeg";

    const prompt =
      `This is a photo of a completed ${sheet.subject} worksheet (rung ${sheet.rung}) that a child filled in by hand.\n\n` +
      `The worksheet's questions were:\n${JSON.stringify(sheet.questions)}\n\n` +
      `The answer key is:\n${JSON.stringify(sheet.answer_key)}\n\n` +
      `There are ${sheet.mtotal} graded questions total. Read the child's handwritten answers in the photo and estimate how many of the ${sheet.mtotal} are correct against the answer key. Give a short note (1-2 sentences) on anything ambiguous, hard to read, or worth a human double-check.`;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: GRADE_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: photoB64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!claudeResp.ok) {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ error: "claude request failed" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }

    const claudeJson = await claudeResp.json();
    if (claudeJson.stop_reason === "refusal") {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ ok: true, refused: true }), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    const textBlock = (claudeJson.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ error: "no text block in response" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
    const verdict = JSON.parse(textBlock.text);

    await sb.from("sheets").update({ ai_verdict: verdict, status: "pending_review" }).eq("id", sheet_id);

    return new Response(JSON.stringify({ ok: true, verdict }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
});
