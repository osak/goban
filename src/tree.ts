/**
 * SGF のゲームツリーと同じ形の、不変（immutable）なツリー。DOM に依存しない。
 *
 * 編集は、変えたノードから根までを作り直して新しい根を返す（パスコピー）。
 * 変えていない部分木は前の版と共有する。作り直したノードは元の id を引き継ぐ。
 *
 * プロパティの値は、SGF のファイルに書かれている形（[ と ] の間の文字列。エスケープは解かない）で持つ。
 * 型ごとの読み書きは sgf/values.ts で行う。こうすると、型を知らないプロパティも、
 * composed の区切りの : やソフト改行も、往復で変わらない。
 */

/** プロパティの値の列。値は SGF に書かれている形のまま（エスケープを解かない） */
export type PropValues = readonly string[];
/** プロパティ名 → 値の列。読み込んだ順を保つ */
export type Props = ReadonlyMap<string, PropValues>;

export interface SgfNode {
  /** 実行時だけの識別子。保存しない。編集で作り直しても同じノードなら同じ id */
  readonly id: number;
  readonly props: Props;
  /** children[0] が本線 */
  readonly children: readonly SgfNode[];
}

/** 根から、各ノードで何番目の子をたどるか */
export type NodePath = readonly number[];

let lastId = 0;

function nextId(): number {
  return ++lastId;
}

/** 新しいノードを作る（新しい id を振る） */
export function createNode(
  props: Iterable<readonly [string, PropValues]> = [],
  children: readonly SgfNode[] = [],
): SgfNode {
  return { id: nextId(), props: new Map(props), children };
}

/** 値を持たないプロパティ（GBMV[] など）の値 */
export const NONE: PropValues = [''];

export function getProp(node: SgfNode, ident: string): PropValues | undefined {
  return node.props.get(ident);
}

/** 1 つめの値（なければ undefined） */
export function getValue(node: SgfNode, ident: string): string | undefined {
  return node.props.get(ident)?.[0];
}

/** id と子を保ったまま、プロパティを入れ替えたノード */
export function withProps(node: SgfNode, props: Props): SgfNode {
  return { id: node.id, props, children: node.children };
}

/** id とプロパティを保ったまま、子を入れ替えたノード */
export function withChildren(node: SgfNode, children: readonly SgfNode[]): SgfNode {
  return { id: node.id, props: node.props, children };
}

/**
 * プロパティを 1 つ書き換えたノード。values が null か空なら消す。
 * すでにあるプロパティを書き換えるときは、並びの位置を保つ。
 */
export function setProp(node: SgfNode, ident: string, values: PropValues | null): SgfNode {
  const props = new Map(node.props);
  if (values === null || values.length === 0) {
    if (!props.delete(ident)) return node;
  } else {
    props.set(ident, values);
  }
  return withProps(node, props);
}

/** path のノード（なければ null） */
export function nodeAt(root: SgfNode, path: NodePath): SgfNode | null {
  let n = root;
  for (const k of path) {
    const c = n.children[k];
    if (!c) return null;
    n = c;
  }
  return n;
}

/** 根から path のノードまでのノードの列（根を含む。path が不正なら null） */
export function nodesOnPath(root: SgfNode, path: NodePath): SgfNode[] | null {
  const out = [root];
  let n = root;
  for (const k of path) {
    const c = n.children[k];
    if (!c) return null;
    out.push(c);
    n = c;
  }
  return out;
}

function nodesOrThrow(root: SgfNode, path: NodePath): SgfNode[] {
  const nodes = nodesOnPath(root, path);
  if (!nodes) throw new RangeError(`invalid path: ${path.join(',')}`);
  return nodes;
}

/** path のノードを f で置き換え、根までを作り直した新しい根 */
export function updateAt(root: SgfNode, path: NodePath, f: (node: SgfNode) => SgfNode): SgfNode {
  const nodes = nodesOrThrow(root, path);
  let cur = f(nodes[nodes.length - 1]);
  for (let d = path.length - 1; d >= 0; d--) {
    const parent = nodes[d];
    const children = parent.children.slice();
    children[path[d]] = cur;
    cur = withChildren(parent, children);
  }
  return cur;
}

/** path のノードの最後の子として child を足す。新しい根と、足した子への path を返す */
export function addChild(root: SgfNode, path: NodePath, child: SgfNode): { root: SgfNode; path: number[] } {
  let index = 0;
  const next = updateAt(root, path, (n) => {
    index = n.children.length;
    return withChildren(n, [...n.children, child]);
  });
  return { root: next, path: [...path, index] };
}

/** path のノード（とその先）を消した新しい根。根は消せない */
export function removeAt(root: SgfNode, path: NodePath): SgfNode {
  if (path.length === 0) throw new RangeError('cannot remove the root');
  const k = path[path.length - 1];
  return updateAt(root, path.slice(0, -1), (n) => {
    if (!n.children[k]) throw new RangeError(`invalid path: ${path.join(',')}`);
    return withChildren(n, n.children.filter((_, i) => i !== k));
  });
}

/** path のノードを抜き、その子をそのノードの位置に入れた新しい根。根は抜けない */
export function spliceOut(root: SgfNode, path: NodePath): SgfNode {
  if (path.length === 0) throw new RangeError('cannot splice out the root');
  const k = path[path.length - 1];
  return updateAt(root, path.slice(0, -1), (n) => {
    const target = n.children[k];
    if (!target) throw new RangeError(`invalid path: ${path.join(',')}`);
    return withChildren(n, [...n.children.slice(0, k), ...target.children, ...n.children.slice(k + 1)]);
  });
}

/** parentPath のノードの子の順番を変える（from 番目の子を to 番目へ）。to = 0 で本線にする */
export function moveChild(root: SgfNode, parentPath: NodePath, from: number, to: number): SgfNode {
  return updateAt(root, parentPath, (n) => {
    const children = n.children.slice();
    if (!children[from] || to < 0 || to >= children.length) {
      throw new RangeError(`invalid child index: ${from} -> ${to}`);
    }
    const [c] = children.splice(from, 1);
    children.splice(to, 0, c);
    return withChildren(n, children);
  });
}

/** id のノードへの path（なければ null） */
export function findPath(root: SgfNode, id: number): number[] | null {
  // 長い手順でも呼び出しの深さが増えないよう、スタックでたどる
  const stack: Array<{ node: SgfNode; path: number[] }> = [{ node: root, path: [] }];
  for (let cur = stack.pop(); cur; cur = stack.pop()) {
    if (cur.node.id === id) return cur.path;
    const { children } = cur.node;
    for (let k = children.length - 1; k >= 0; k--) {
      stack.push({ node: children[k], path: [...cur.path, k] });
    }
  }
  return null;
}

/** path から先を、最初の子をたどって最後まで伸ばした path（今の手順） */
export function extendPath(root: SgfNode, path: NodePath): number[] {
  const out = [...path];
  let n = nodeAt(root, path);
  if (!n) throw new RangeError(`invalid path: ${path.join(',')}`);
  while (n.children.length > 0) {
    out.push(0);
    n = n.children[0];
  }
  return out;
}

/** ツリーのノードの数 */
export function countNodes(root: SgfNode): number {
  let count = 0;
  const stack = [root];
  for (let n = stack.pop(); n; n = stack.pop()) {
    count++;
    stack.push(...n.children);
  }
  return count;
}
