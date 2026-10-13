// Calls Logbook ops over REST with a bearer token: the CLI and the Linear importer share it.
export type Call = <T = any>(op: string, input?: unknown) => Promise<T>;

export function client(url = process.env.LOGBOOK_URL, token = process.env.LOGBOOK_TOKEN): Call {
  if (!url || !token) throw new Error("Set LOGBOOK_URL and LOGBOOK_TOKEN (create a token in Settings or with create_token)");
  const base = url.replace(/\/+$/, "");
  return async (op, input = {}) => {
    const res = await fetch(`${base}/api/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(`${op}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return body;
  };
}
