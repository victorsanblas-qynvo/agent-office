// Copies with the clipboard API, or with the selection of a textarea where the browser does not allow it.
export async function copyText(text: string, source?: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = source ?? document.createElement('textarea');
    if (source === undefined) {
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
    }
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      if (source === undefined) area.remove();
    }
  }
}
