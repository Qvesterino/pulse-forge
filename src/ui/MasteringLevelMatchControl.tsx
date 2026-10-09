import { useId } from "react";

export function MasteringLevelMatchControl({
  checked,
  disabled = false,
  labelClassName,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  labelClassName?: string;
  onChange(checked: boolean): void;
}) {
  const id = useId().replaceAll(":", "");
  const helpId = `mastering-level-match-help-${id}`;

  return (
    <div className="mastering-level-match-control">
      <label className={labelClassName}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.checked)}
        />
        Match audition loudness
      </label>
      <p id={helpId} className="mastering-level-match-help" aria-live="polite" aria-atomic="true">
        {checked
          ? "On: audition only attenuates the louder side to the quieter measured LUFS-I; it never boosts. If LUFS-I cannot be measured, playback uses native levels. Project settings, snapshots, and exports are unchanged."
          : "Off: auditions use native levels with no match trim. Project settings, snapshots, and exports are unchanged."}
      </p>
    </div>
  );
}
