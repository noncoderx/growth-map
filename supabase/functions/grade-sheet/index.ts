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

  // deno-lint-ignore no-explicit-any
  let sb: any = null;
  let sheetId: string | undefined;
  let sheetLoaded = false;

  try {
    const { sheet_id } = await req.json();
    sheetId = sheet_id;
    if (!sheet_id) {
      return new Response(JSON.stringify({ error: "sheet_id required" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    sb = createClient(SB_URL, SB_SERVICE_KEY);

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

    // From here on the sheet row is confirmed to exist. Every failure past
    // this point must still flip status to 'pending_review' so the sheet
    // never gets stuck at 'pending_upload' — the mastery-check UI falls back
    // to manual grading whenever ai_verdict is absent, but only once the
    // sheet has moved out of pending_upload.
    sheetLoaded = true;
    const failAsPendingReview = async (body: Record<string, unknown>, status: number) => {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id).neq("status", "approved");
      return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
    };

    const { data: pub } = sb.storage.from("sheet-photos").getPublicUrl(sheet.photo_url);
    const photoResp = await fetch(pub.publicUrl);
    if (!photoResp.ok) {
      return await failAsPendingReview({ error: "could not fetch photo" }, 502);
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
        max_tokens: 2048,
        thinking: { type: "disabled" },
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
      const bodyText = await claudeResp.text();
      console.error(
        `grade-sheet: claude request failed sheet_id=${sheet_id} status=${claudeResp.status} body=${bodyText}`,
      );
      return await failAsPendingReview({ error: "claude request failed" }, 502);
    }

    const claudeJson = await claudeResp.json();
    if (claudeJson.stop_reason === "refusal") {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id).neq("status", "approved");
      return new Response(JSON.stringify({ ok: true, refused: true }), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    const textBlock = (claudeJson.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) {
      return await failAsPendingReview({ error: "no text block in response" }, 502);
    }

    let verdict;
    try {
      verdict = JSON.parse(textBlock.text);
    } catch (parseErr) {
      console.error(
        `grade-sheet: failed to parse claude verdict JSON sheet_id=${sheet_id} error=${String(parseErr)} raw=${textBlock.text}`,
      );
      return await failAsPendingReview({ error: "invalid verdict JSON from claude" }, 502);
    }

    await sb
      .from("sheets")
      .update({ ai_verdict: verdict, status: "pending_review" })
      .eq("id", sheet_id)
      .neq("status", "approved");

    return new Response(JSON.stringify({ ok: true, verdict }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (e) {
    console.error(`grade-sheet: unhandled error sheet_id=${sheetId ?? "unknown"} error=${String(e)}`);
    if (sheetLoaded && sb && sheetId) {
      try {
        await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheetId).neq("status", "approved");
      } catch (updateErr) {
        console.error(`grade-sheet: failed to flip status after unhandled error: ${String(updateErr)}`);
      }
    }
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
});
