import React, { useEffect, useState } from 'react';

interface SmoothNumberInputProps {
  value: number;
  onChange: (val: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}

export const SmoothNumberInput: React.FC<SmoothNumberInputProps> = ({
  value,
  onChange,
  step = 1,
  min,
  max,
  precision,
  className = '',
  placeholder,
  ariaLabel,
}) => {
  const formatVal = (v: number): string => {
    if (!Number.isFinite(v)) return '';
    if (precision !== undefined) return v.toFixed(precision);
    return String(v);
  };

  const [text, setText] = useState<string>(() => formatVal(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setText(formatVal(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, precision]);

  const clampVal = (v: number): number => {
    let out = v;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    return out;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(parsed)) {
      if ((min === undefined || parsed >= min) && (max === undefined || parsed <= max)) {
        onChange(parsed);
      }
    }
  };

  const commitText = () => {
    setFocused(false);
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      setText(formatVal(value));
      return;
    }
    const clamped = clampVal(parsed);
    onChange(clamped);
    setText(formatVal(clamped));
  };

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onChange={handleChange}
      onBlur={commitText}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commitText();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
};
