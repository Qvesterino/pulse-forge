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
      <p id={helpId} className="mastering-level-match-help">
        When enabled, audition only attenuates the louder side to the quieter measured LUFS-I; it never boosts. If
        LUFS-I cannot be measured, playback uses native levels. The trim does not change project or saved settings,
        snapshots, or exports.
      </p>
    </div>
  );
}
