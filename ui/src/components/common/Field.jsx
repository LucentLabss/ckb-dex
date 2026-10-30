export default function Field({ label, suffix, hint, invalid, ...inputProps }) {
  return (
    <div className="field">
      <label>
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </label>
      <div className={`input ${invalid ? "invalid" : ""}`}>
        <input aria-invalid={invalid || undefined} {...inputProps} />
        {suffix && <span className="sel">{suffix}</span>}
      </div>
    </div>
  );
}
