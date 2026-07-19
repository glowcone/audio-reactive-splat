export async function onRequestGet({ env }) {
  const object = await env.SPLATS.get("gaussian/point_cloud_1.ply");
  if (!object) return new Response("Splat asset not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
