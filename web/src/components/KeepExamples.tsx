// "Also keep the examples?": a sandbox arrives with sample records, and the
// file of what the person made carries only theirs unless they tick this
// (#4217). Off by default; one control wherever the file is offered.
export function KeepExamples({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted" data-testid="keep-examples">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      Also keep the examples we started you with
    </label>
  );
}
