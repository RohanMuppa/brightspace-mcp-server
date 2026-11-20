// Prints "true" when version A is newer than version B by full semver
// precedence, "false" otherwise. Used by npm-release.sh.
//   node semver-newer.mjs <A> <B>
const parse = (v) => {
  const [core, pre] = v.split("+")[0].split(/-(.+)/);
  return { n: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
};
const part = (x, y) => {
  const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
  if (xn && yn) return Math.sign(Number(x) - Number(y));
  if (xn) return -1;
  if (yn) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
};
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const c = part(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
};
console.log(compare(parse(process.argv[2]), parse(process.argv[3])) > 0);
