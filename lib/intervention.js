// The host persists ToolErrorInfo on tool/result, separately from model text.
// Never infer an intervention from arbitrary output containing our envelope.
export const BLOCK_INFO = Object.freeze({ name: 'EngProtocolIntervention', code: 'ENG_PROTOCOL_BLOCKED' })

export function isProtocolBlock(data) {
  return data?.error?.name === BLOCK_INFO.name && data?.error?.code === BLOCK_INFO.code
}
