// Bound expansion BEFORE JSON.stringify allocates indentation for a deep tree.
export function formatResponse(
  body: string,
  truncated = false,
  binary = false,
) {
  if (truncated || binary) return { body, json: false, limited: false };
  let depth = 0,
    quoted = false,
    escaped = false,
    estimate = body.length;
  for (const character of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if ("{},[]:".includes(character)) estimate += 4 + Math.max(0, depth) * 4;
    if (depth > 64 || estimate > 2 * 1024 * 1024)
      return { body, json: false, limited: true };
    if (character === "}" || character === "]") depth--;
  }
  try {
    return {
      body: JSON.stringify(JSON.parse(body), null, 2),
      json: true,
      limited: false,
    };
  } catch {
    return { body, json: false, limited: false };
  }
}
