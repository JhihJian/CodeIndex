// Preserve source offsets while skipping comments and literals before recognizing directives.
// Preprocessor evaluation and macro-expanded include paths require build context.
export function* cIncludes(source) {
  const tokens = /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^[\t ]*#[\t ]*include[\t ]*([<"])([^>"\r\n]+)[>"]/gm;
  for (const match of source.matchAll(tokens)) {
    if (match[1]) yield { path: match[2], quoted: match[1] === '"', index: match.index };
  }
}
