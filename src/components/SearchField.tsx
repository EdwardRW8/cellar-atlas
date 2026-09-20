import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

export function SearchField({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{ position: "relative", flex: 1 }}>
      <label htmlFor="collection-search" className="visually-hidden">
        {placeholder}
      </label>
      <input
        id="collection-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          minHeight: TOUCH_TARGET_MIN_PX,
          background: "rgba(255,255,255,0.05)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          padding: "0.625rem 2.25rem 0.625rem 0.875rem",
          color: "var(--text-primary)",
          fontSize: "1rem" /* 16px stops iOS zooming on focus */,
          outline: "none",
        }}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label="Clear search"
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            minWidth: 40,
            minHeight: 40,
            color: "var(--text-tertiary)",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
