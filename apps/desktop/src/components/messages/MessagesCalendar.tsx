import { useState, useMemo } from 'react';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function MessagesCalendar() {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState<Date | null>(null);

  const { days, firstWeekday, todayKey } = useMemo(() => {
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    return {
      days: Array.from({ length: daysInMonth }, (_, i) => i + 1),
      firstWeekday: new Date(viewYear, viewMonth, 1).getDay(),
      todayKey: new Date().toDateString(),
    };
  }, [viewYear, viewMonth]);

  const prev = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const next = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };
  const goToday = () => {
    setViewMonth(today.getMonth());
    setViewYear(today.getFullYear());
    setSelected(today);
  };

  return (
    <div className="flex flex-col p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-white truncate">{MONTHS[viewMonth]}</div>
          <div className="text-[10px] text-white/40 font-medium">{viewYear}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={prev}
            title="Previous month"
            className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            onClick={goToday}
            title="Jump to today"
            className="h-6 px-2 rounded text-[10px] font-semibold text-white/60 hover:text-ghost-green hover:bg-white/10 transition-colors uppercase tracking-wider"
          >
            Today
          </button>
          <button
            onClick={next}
            title="Next month"
            className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1.5">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className="text-[9px] text-white/30 text-center font-semibold uppercase tracking-wider">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstWeekday }).map((_, i) => <div key={`blank-${i}`} />)}
        {days.map((day) => {
          const date = new Date(viewYear, viewMonth, day);
          const isToday = date.toDateString() === todayKey;
          const isSelected = selected?.toDateString() === date.toDateString();
          return (
            <button
              key={day}
              onClick={() => setSelected(date)}
              className={`aspect-square text-[11px] rounded-md flex items-center justify-center transition-colors font-medium ${
                isSelected
                  ? 'text-white font-bold'
                  : isToday
                    ? 'text-ghost-green font-bold'
                    : 'text-white/70 hover:bg-white/[0.06]'
              }`}
              style={{
                background: isSelected
                  ? 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)'
                  : isToday
                    ? 'rgba(0,255,200,0.08)'
                    : undefined,
                boxShadow: isSelected ? '0 2px 8px rgba(124,58,237,0.4)' : undefined,
              }}
            >
              {day}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mt-4 pt-4 border-t border-white/[0.06]">
          <p className="text-[9px] text-white/35 uppercase tracking-wider font-semibold mb-1.5">Selected</p>
          <p className="text-[12px] text-white font-medium leading-tight">
            {selected.toLocaleDateString('en-US', { weekday: 'long' })}
          </p>
          <p className="text-[11px] text-white/55 mt-0.5">
            {selected.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
          <p className="text-[10px] text-white/35 italic mt-3">No events yet</p>
        </div>
      )}
    </div>
  );
}
