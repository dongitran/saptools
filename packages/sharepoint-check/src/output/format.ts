import type { DecodedTokenClaims, FolderTreeNode, ValidateResult } from "../types.js";

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex] ?? "B"}`;
}

export function summarizeToken(claims: DecodedTokenClaims): string {
  const parts: string[] = [];
  if (claims.appDisplayName !== undefined) {
    parts.push(`App: ${claims.appDisplayName}`);
  }
  if (claims.appId !== undefined) {
    parts.push(`AppId: ${claims.appId}`);
  }
  if (claims.tenantId !== undefined) {
    parts.push(`Tenant: ${claims.tenantId}`);
  }
  if (claims.roles.length > 0) {
    parts.push(`Roles: ${claims.roles.join(", ")}`);
  } else if (claims.scopes.length > 0) {
    parts.push(`Scopes: ${claims.scopes.join(", ")}`);
  } else {
    parts.push("Roles: (none)");
  }
  return parts.join(" | ");
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function renderNode(node: FolderTreeNode, depth: number, out: string[]): void {
  const label = depth === 0 ? (node.path.length === 0 ? "/" : node.path) : node.name;
  const stats = `(${node.fileCount.toString()} files, ${node.folderCount.toString()} subfolders, ${formatBytes(
    node.totalSize,
  )})`;
  out.push(`${indent(depth)}- ${label} ${stats}`);
  for (const child of node.children) {
    renderNode(child, depth + 1, out);
  }
}

export function renderFolderTree(root: FolderTreeNode): string {
  const lines: string[] = [];
  renderNode(root, 0, lines);
  return lines.join("\n");
}

export function renderValidateResult(result: ValidateResult): string {
  const lines: string[] = [];
  const rootLabel = result.root.path.length === 0 ? "/" : result.root.path;
  const rootMark = result.root.exists && result.root.isFolder ? "✔" : "✘";
  lines.push(`${rootMark} root: ${rootLabel}`);

  for (const sub of result.subdirectories) {
    const mark = sub.exists && sub.isFolder ? "✔" : "✘";
    lines.push(`${mark} ${sub.path}`);
  }

  lines.push(result.allPresent ? "All expected folders present." : "Some expected folders are missing.");
  return lines.join("\n");
}
