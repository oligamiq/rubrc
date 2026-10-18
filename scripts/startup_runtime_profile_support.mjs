export function processTree(text, rootPid) {
  const rows = text.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]),
      kind: match[4].match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? "browser" }];
  });
  const ids = new Set([rootPid]);
  let previous;
  do {
    previous = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  } while (previous !== ids.size);
  return rows.filter(row => ids.has(row.pid));
}
