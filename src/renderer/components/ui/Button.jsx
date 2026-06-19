export function Button({
  children, variant = 'default', size = 'md',
  pill = false, square = false, className = '', disabled, onClick, ...rest
}) {
  const base = 'inline-flex items-center justify-center gap-1.5 font-medium transition-all select-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
  const shape = pill ? 'rounded-full' : square ? 'rounded-[6px]' : 'rounded-[10px]';

  const variants = {
    default:   'bg-white hover:bg-[#f5f2e9] text-[#1a1814] border border-[#ddd9cf] shadow-[0_1px_3px_rgba(26,24,20,0.07)]',
    primary:   'bg-[#5c6e00] hover:bg-[#6d8200] text-white border border-transparent shadow-[0_1px_3px_rgba(92,110,0,0.25)]',
    ghost:     'bg-transparent hover:bg-[#f0ece3] text-[#5c5448] hover:text-[#1a1814] border border-transparent',
    soft:      'bg-[#eef1d6] hover:bg-[#e4e9c6] text-[#3d4900] border border-transparent',
    danger:    'bg-transparent hover:bg-[#f5e0d4] text-[#b45837] border border-transparent',
    record:    'bg-[#5c6e00] hover:bg-[#6d8200] text-white border border-transparent shadow-[0_1px_4px_rgba(92,110,0,0.2)]',
    recording: 'bg-[#b45837] hover:bg-[#cc6640] text-white border border-transparent animate-record-pulse',
    subtle:    'bg-[#f5f2e9] hover:bg-[#ede9df] text-[#5c5448] hover:text-[#1a1814] border border-[#e4e0d5]',
    dark:      'bg-[#1a1814] hover:bg-[#2a2620] text-white border border-transparent',
  };

  const sizes = {
    xs: 'px-2.5 py-1.5 text-[12px]',
    sm: 'px-3.5 py-2 text-[13px]',
    md: 'px-5 py-2.5 text-[14px]',
    lg: 'px-5 py-2.5 text-[14px]',
    xl: 'px-6 py-3 text-[15px]',
  };

  return (
    <button
      className={`${base} ${shape} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}
