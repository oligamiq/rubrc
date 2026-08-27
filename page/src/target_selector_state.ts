export function createTargetSelectorState(
  disabled: () => boolean,
  onChange: (value: string) => void,
) {
  let isOpen = false;
  return {
    open: () => isOpen,
    toggle() {
      if (disabled()) return;
      isOpen = !isOpen;
    },
    close() {
      isOpen = false;
    },
    select(value: string) {
      if (disabled()) return;
      onChange(value);
      isOpen = false;
    },
  };
}
