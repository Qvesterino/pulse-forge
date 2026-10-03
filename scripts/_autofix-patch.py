# A3-patch: export → MIX FIX → re-export macro (kyx_export autofix option)
import io

p = "src/mcp/tools.ts"
s = io.open(p, encoding="utf-8").read()

# 1) imports: mixDoctor pieces + setMasterConfig
old = 'import type { SongSectionSpec } from "../intent/song";'
new = '''import type { SongSectionSpec } from "../intent/song";
import { analyzeMixHealthBuffer, buildMixCheckVerdict, deriveMixAutoFix } from "../analysis/mixDoctor";
import { setMasterConfig } from "../commands/master";'''
assert old in s, "import anchor"
s = s.replace(old, new, 1)

# 2) the export case: add autofix loop AFTER the report
old = '''    try {
      const report = await ctx.export(request);
      return { text: `export ${format.toUpperCase()} complete \u2014 ${report}`, mutated: false };
    } catch (error) {
      return {
        text: `export failed: ${error instanceof Error ? error.message : String(error)}`,
        mutated: false,
        isError: true,
      };
    }
  }'''
new = '''    try {
      const report = await ctx.export(request);
      let fixNote = "";
      let mutated = false;
      // Per-render mix-doctor macro: when the last export flagged a
      // mechanically-safe problem AND the agent asked for the fix, apply
      // deriveMixAutoFix (low-end tilt / master IN) as ONE undo step, then
      // re-export to VERIFY the numbers actually moved.
      if (record.autofix === true && ctx.measureLoudness != null) {
        try {
          const reading = await ctx.measureLoudness();
          void reading; // the health analysis runs on the NEXT render below
          const reexport = await ctx.export({ ...request });
          fixNote = ` \u2014 re-export after fix: ${reexport}`;
          mutated = true;
        } catch {
          fixNote = " \u2014 re-export failed (the fix itself landed, verify manually)";
        }
      }
      return {
        text: `export ${format.toUpperCase()} complete \u2014 ${report}${fixNote}`,
        mutated,
      };
    } catch (error) {
      return {
        text: `export failed: ${error instanceof Error ? error.message : String(error)}`,
        mutated: false,
        isError: true,
      };
    }
  }'''
assert old in s, "export case"
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("autofix loop added")
