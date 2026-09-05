// docs/DESIGN.md §9.5、D-14：標記出現在檔名或內容裡就模擬失敗；只在 FAILURE_INJECTION=true 時生效。
export const MARKERS = {
  failExtract: '[[FAIL_EXTRACT]]',
  failEmbedOnce: '[[FAIL_EMBED_ONCE]]',
  failEmbed: '[[FAIL_EMBED]]',
  slow: '[[SLOW]]',
} as const;

export const SLOW_STAGE_DELAY_MS = 3000;

export function hasMarker(marker: string, ...haystacks: (string | null | undefined)[]): boolean {
  return haystacks.some((h) => h !== null && h !== undefined && h.includes(marker));
}
