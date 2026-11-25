/** Normalize a user-selected HTTP(S) reference without fetching it. */
export function safeContextLink(locator) {
  if (typeof locator !== 'string' || !/^https?:\/\//iu.test(locator) ||
      /[\u0000-\u0020\u007f\\]/u.test(locator)) return undefined
  const url = URL.parse(locator)
  if (url && !url.username && !url.password && url.href.length <= 8192) return url.href
}
