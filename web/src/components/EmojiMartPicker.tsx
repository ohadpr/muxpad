import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

/**
 * Thin wrapper around emoji-mart's searchable picker (the Notion-style
 * full emoji keyboard). Loaded lazily so its emoji dataset stays out of
 * the main bundle — only fetched when a user opens the icon picker.
 */
export default function EmojiMartPicker({
  theme,
  onPick,
}: {
  theme: 'light' | 'dark';
  onPick: (icon: string) => void;
}) {
  return (
    <Picker
      data={data}
      theme={theme}
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
      previewPosition="none"
      skinTonePosition="search"
      navPosition="top"
      autoFocus
    />
  );
}
