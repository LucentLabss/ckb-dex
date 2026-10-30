export default function SegmentedControl({ options, value, onChange, className = "" }) {
  return (
    <div className={`seg ${className}`}>
      {options.map((o) => (
        <button key={o} className={o === value ? "on" : ""} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}
