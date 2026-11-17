/**
 * 中文成对引号：把正文里的直双引号 `"` 按出现顺序配成 “ ”。
 *
 * 为什么不用内置的 smartypants：
 * 它判断「开引号还是闭引号」靠的是前一个字符是不是空白或左括号。中文没有词间
 * 空格，`你以为"分代"是一个意思` 里的第一个引号前面是「为」，于是被判成闭引号，
 * 结果是两个右引号 `”分代”` —— 全站第一处正文带引号的文章就暴露了这个坑。
 *
 * 这里的策略是「成对交替，且只在总数是偶数时动手」：配不上对就整篇不动，
 * 宁可留直引号，也不要把引号配错位置。代码块与行内代码不参与。
 */

const QUOTE = '"';

function collectText(node, out) {
  if (!node || typeof node !== 'object') return;
  // 代码里的引号是语法，不是标点
  if (node.type === 'inlineCode' || node.type === 'code' || node.type === 'html') return;
  if (node.type === 'text' && typeof node.value === 'string') {
    out.push(node);
    return;
  }
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) collectText(child, out);
  }
}

export default function remarkCjkQuotes() {
  return (tree) => {
    const nodes = [];
    collectText(tree, nodes);

    let total = 0;
    for (const node of nodes) {
      for (const ch of node.value) if (ch === QUOTE) total += 1;
    }
    if (total === 0 || total % 2 !== 0) return;

    let opening = true;
    for (const node of nodes) {
      if (!node.value.includes(QUOTE)) continue;
      let next = '';
      for (const ch of node.value) {
        if (ch === QUOTE) {
          next += opening ? '\u201C' : '\u201D';
          opening = !opening;
        } else {
          next += ch;
        }
      }
      node.value = next;
    }
  };
}
