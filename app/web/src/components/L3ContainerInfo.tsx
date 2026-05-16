interface Props {
  container: Record<string, unknown> | null;
}

interface Mount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function L3ContainerInfo({ container }: Props) {
  if (!container) return <p className="muted">No container metadata.</p>;

  const image = typeof container.image === 'string' ? container.image : '—';
  const mode = typeof container.mode === 'string' ? container.mode : '—';
  const privileged = container.privileged === true;
  const runAsRoot = container.runAsRoot === true;
  const mounts: Mount[] = Array.isArray(container.mounts)
    ? (container.mounts as Mount[]).filter(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          typeof m.containerPath === 'string',
      )
    : [];
  const env = (container.env ?? {}) as Record<string, string>;
  const envKeys = Object.keys(env);

  return (
    <div className="l3-text">
      <div className="l3-kv">
        <KV k="mode" v={mode} />
        <KV k="image" v={image} mono />
        {privileged && <KV k="privileged" v="true" />}
        {runAsRoot && <KV k="runAsRoot" v="true" />}
      </div>

      <h4 className="l3-h4">Mounts ({mounts.length})</h4>
      {mounts.length === 0 ? (
        <p className="muted">No mounts.</p>
      ) : (
        <table className="l3-table">
          <thead>
            <tr>
              <th>container path</th>
              <th>perm</th>
              <th>host path</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((m, i) => (
              <tr key={i}>
                <td>
                  <code>{m.containerPath}</code>
                </td>
                <td>
                  <span className={`chip ${m.readonly ? 'mount-ro' : 'mount-rw'}`}>
                    {m.readonly ? 'ro' : 'rw'}
                  </span>
                </td>
                <td>
                  <code className="muted">{m.hostPath}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {envKeys.length > 0 && (
        <>
          <h4 className="l3-h4">Environment ({envKeys.length})</h4>
          <table className="l3-table">
            <tbody>
              {envKeys.map((k) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>
                    <code className="muted">{env[k]}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="l3-kv-row">
      <span className="label">{k}</span>
      {mono ? <code>{v}</code> : <span className="value">{v}</span>}
    </div>
  );
}
