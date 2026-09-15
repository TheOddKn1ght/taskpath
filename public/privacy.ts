export {};
// Independent of vault startup: the notice also works before signing in.
const dialog = document.querySelector<HTMLDialogElement>('#privacy-dialog')!;
const title = document.querySelector<HTMLElement>('#privacy-title')!;
let opener: HTMLButtonElement | null = null;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-privacy-open]')) {
  button.addEventListener('click', () => {
    opener = button;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    title.focus({ preventScroll: true });
  });
}
document.querySelector<HTMLButtonElement>('#privacy-close')!.addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
  opener = null;
});
