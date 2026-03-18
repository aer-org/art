import type { PipelineConfig } from '../types';

interface Props {
  policy: PipelineConfig['errorPolicy'];
  onChange: (policy: PipelineConfig['errorPolicy']) => void;
}

export function ErrorPolicyPanel({ policy, onChange }: Props) {
  return (
    <fieldset className="error-policy">
      <legend>Error Policy</legend>
      <label>
        Max consecutive errors
        <input
          type="number"
          min={1}
          max={10}
          value={policy.maxConsecutive}
          onChange={(e) => onChange({ ...policy, maxConsecutive: parseInt(e.target.value) || 3 })}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={policy.debugOnMaxErrors}
          onChange={(e) => onChange({ ...policy, debugOnMaxErrors: e.target.checked })}
        />
        Debug on max errors
      </label>
    </fieldset>
  );
}
