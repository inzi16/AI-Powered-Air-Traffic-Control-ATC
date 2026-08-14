import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Command, Search, X } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  group: string;
  icon: ReactNode;
  run: () => void;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

function isFocusable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && !element.hasAttribute('disabled') && element.tabIndex !== -1;
}

export default function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const listId = useId();

  const visibleCommands = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands;
    return commands.filter((item) => {
      const searchable = [item.label, item.description, item.group, ...(item.keywords || [])].join(' ').toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button, input, [tabindex]')].filter(isFocusable);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const safeIndex = visibleCommands.length ? Math.min(activeIndex, visibleCommands.length - 1) : 0;
  const runCommand = (item: PaletteCommand) => {
    if (item.disabled) return;
    onClose();
    item.run();
  };

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="command-palette__header">
          <Command aria-hidden="true" />
          <div><span className="eyebrow">Operations</span><h2 id={titleId}>Command palette</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close command palette"><X aria-hidden="true" /></button>
        </header>
        <div className="command-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            type="search"
            aria-label="Search commands"
            aria-controls={listId}
            aria-activedescendant={visibleCommands[safeIndex] ? `command-${visibleCommands[safeIndex].id}` : undefined}
            placeholder="Search views, alerts, route, or tools"
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((current) => visibleCommands.length ? (current + 1) % visibleCommands.length : 0);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((current) => visibleCommands.length ? (current - 1 + visibleCommands.length) % visibleCommands.length : 0);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                setActiveIndex(Math.max(0, visibleCommands.length - 1));
              } else if (event.key === 'Enter' && visibleCommands[safeIndex]) {
                event.preventDefault();
                runCommand(visibleCommands[safeIndex]);
              }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-list" id={listId} role="listbox" aria-label="Available commands">
          {visibleCommands.map((item, index) => (
            <button
              id={`command-${item.id}`}
              key={item.id}
              className={`command-item ${index === safeIndex ? 'is-active' : ''}`}
              type="button"
              role="option"
              aria-selected={index === safeIndex}
              disabled={item.disabled}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => runCommand(item)}
            >
              <span className="command-item__icon">{item.icon}</span>
              <span className="command-item__copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              <span className="command-item__meta"><em>{item.group}</em>{item.shortcut && <kbd>{item.shortcut}</kbd>}</span>
            </button>
          ))}
          {!visibleCommands.length && <div className="command-empty"><Search aria-hidden="true" /><strong>No matching command</strong><span>Try “radar”, “route”, “alerts”, or “sync”.</span></div>}
        </div>
        <footer className="command-palette__footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>ENTER</kbd> Run</span><span>Shortcuts are disabled while typing</span></footer>
      </div>
    </div>
  );
}
