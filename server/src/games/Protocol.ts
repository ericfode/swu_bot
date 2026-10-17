/** Checks the negotiated protocol evidence crossing local/helper process boundaries. */
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)

export const protocolResultError = (r: unknown, requiredProtocol?: 2): string | null => {
  if (requiredProtocol !== 2) return null
  if (!plain(r) || r.requiredProtocol !== 2) return "missing requiredProtocol 2"
  if (!plain(r.protocols)) return "missing accepted protocols per seat"
  if (Object.entries(r.protocols).some(([seat, version]) => !["p1", "p2"].includes(seat) || version !== 2)) return "invalid accepted protocol per seat"
  // A rejected hello or load failure is an auditable error, never evidence of a completed negotiation.
  if (r.outcome !== "ERROR" && (r.protocols.p1 !== 2 || r.protocols.p2 !== 2)) return "both seats must explicitly accept protocol 2"
  return null
}

export const protocolReplayError = (text: string | null | undefined, result: unknown, requiredProtocol?: 2): string | null => {
  if (requiredProtocol !== 2) return null
  if (text == null) return plain(result) && result.outcome === "ERROR" ? null : "missing protocol replay"
  let end: unknown
  try {
    end = JSON.parse(text.trimEnd().split("\n").at(-1)!)
  } catch {
    return "invalid replay end"
  }
  if (!plain(end) || end.t !== "end") return "missing replay end"
  const why = protocolResultError(end, requiredProtocol)
  if (why) return `replay ${why}`
  if (!plain(result) || !plain(result.protocols) || !plain(end.protocols)) return "replay protocol evidence differs from result"
  const recorded = end.protocols
  const accepted = result.protocols
  if (["p1", "p2"].some((s) => recorded[s] !== accepted[s]) || end.requiredProtocol !== result.requiredProtocol) {
    return "replay protocol evidence differs from result"
  }
  return null
}
