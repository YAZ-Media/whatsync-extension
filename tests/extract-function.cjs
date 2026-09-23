function extractFunction(source, name) {
  const asyncMarker = `async function ${name}`;
  const functionMarker = `function ${name}`;
  const asyncStart = source.indexOf(asyncMarker);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(functionMarker);
  const marker = asyncStart >= 0 ? asyncMarker : functionMarker;
  if (start < 0) throw new Error(`Function not found: ${name}`);
  const signatureOpen = source.indexOf('(', start + marker.length);
  let signatureDepth = 0;
  let signatureClose = -1;
  for (let i = signatureOpen; i < source.length; i += 1) {
    if (source[i] === '(') signatureDepth += 1;
    if (source[i] === ')' && --signatureDepth === 0) { signatureClose = i; break; }
  }
  const open = source.indexOf('{', signatureClose + 1);
  if (open < 0) throw new Error(`Function body not found: ${name}`);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let escaped = false;
  let previousSignificant = '';
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (regex) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '[') { regexClass = true; continue; }
      if (char === ']' && regexClass) { regexClass = false; continue; }
      if (char === '/' && !regexClass) {
        regex = false;
        while (/[a-z]/i.test(source[i + 1] || '')) i += 1;
      }
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '/' && (!previousSignificant || /[({[=:;,!?&|+*%^~<>-]/.test(previousSignificant))) {
      regex = true;
      regexClass = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    if (!/\s/.test(char)) previousSignificant = char;
  }
  throw new Error(`Unterminated function: ${name}`);
}

module.exports = (source, names) => names.map((name) => extractFunction(source, name)).join('\n');
