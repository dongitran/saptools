export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let aIndex = 0; aIndex < a.length; aIndex += 1) {
    const current = [aIndex + 1];
    for (let bIndex = 0; bIndex < b.length; bIndex += 1) {
      const left = current[bIndex] ?? Number.POSITIVE_INFINITY;
      const up = previous[bIndex + 1] ?? Number.POSITIVE_INFINITY;
      const diagonal = previous[bIndex] ?? Number.POSITIVE_INFINITY;
      const insert = left + 1;
      const remove = up + 1;
      const substitute = diagonal + (a.charCodeAt(aIndex) === b.charCodeAt(bIndex) ? 0 : 1);
      current.push(Math.min(insert, remove, substitute));
    }
    previous = current;
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY;
}
