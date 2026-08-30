export function populateFileDrag(dataTransfer, files = []) {
  if (!dataTransfer) return 0;
  // Browsers may pre-populate text/plain or text/html when a drag starts on a
  // filename or image descendant. Remove those representations so the target
  // sees one unambiguous payload: real File items.
  try { dataTransfer.clearData(); } catch {}
  dataTransfer.effectAllowed = "copy";
  let added = 0;
  for (const file of files) {
    try { dataTransfer.items.add(file); added += 1; } catch {}
  }
  return added;
}
