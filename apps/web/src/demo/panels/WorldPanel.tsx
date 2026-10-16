import { formatCalendar } from '@civ/sim-core';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatInteger } from '../../lib/format';
import { useDemo } from '../context';
import {
  DEMO_MAX_POPULATION,
  FORM_BOUNDS,
  validateWorldForm,
  type WorldFormErrors,
  type WorldFormField,
  type WorldFormValues,
} from '../describe';
import { ConfirmBar, Section } from '../ui';

/*
 * World tab: generate a new world, keep one in-memory save point, reset to genesis,
 * the state fingerprint, and plain notes on what this demo is and is not.
 */

type Pending = 'create' | 'restore' | 'reset' | null;
/** Where a result message is shown: next to the action that produced it. */
type Area = 'save' | 'reset' | 'create';
interface Message {
  area: Area;
  text: string;
  error: boolean;
  /** Changes with every message, so a repeated text is still scrolled into view. */
  nonce: number;
}

/**
 * Result of an action, shown under the button that was tapped and scrolled into the
 * panel's visible area (on a phone the panel is short and scrolled to the action).
 */
function ActionMessage({ message, area }: { message: Message | null; area: Area }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const shown = message?.area === area ? message : null;
  const nonce = shown?.nonce;
  useEffect(() => {
    if (nonce !== undefined) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [nonce]);
  return (
    <p ref={ref} role="status" className="world-message" data-testid={`world-message-${area}`}>
      {shown && (
        <span className={`alert ${shown.error ? 'alert-error' : 'alert-info'}`}>{shown.text}</span>
      )}
    </p>
  );
}

function formFromSettings(seed: string, config: Record<string, unknown>): WorldFormValues {
  const stochastic = config.stochastic as { weather?: boolean } | undefined;
  return {
    seed,
    population: String(config.population ?? 100),
    daysPerSeason: String(config.daysPerSeason ?? 7),
    stochasticWeather: stochastic?.weather ?? true,
  };
}

function NumberField({
  field,
  label,
  hint,
  values,
  errors,
  onChange,
}: {
  field: 'population' | 'daysPerSeason';
  label: string;
  hint: string;
  values: WorldFormValues;
  errors: WorldFormErrors;
  onChange: (field: WorldFormField, value: string) => void;
}) {
  const id = useId();
  const error = errors[field];
  const { min, max } = FORM_BOUNDS[field];
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={values[field]}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(e) => onChange(field, e.target.value)}
        data-testid={`world-${field}`}
      />
      <span id={`${id}-hint`} className="field-hint">
        {hint}
      </span>
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function WorldPanel({ onWorldReplaced }: { onWorldReplaced: () => void }) {
  const { engine } = useDemo();
  const settings = engine.settings;
  const [values, setValues] = useState<WorldFormValues>(() =>
    formFromSettings(settings.seed, settings.config as Record<string, unknown>),
  );
  const [errors, setErrors] = useState<WorldFormErrors>({});
  // Bumped on every failed validation; moves focus to the first invalid field, which
  // on a phone may be scrolled out of the short panel above the submit button.
  const [invalidNonce, setInvalidNonce] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (invalidNonce === 0) return;
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: 'center' });
  }, [invalidNonce]);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessageState] = useState<Message | null>(null);
  const setMessage = (area: Area, text: string, error = false) =>
    setMessageState((m) => ({ area, text, error, nonce: (m?.nonce ?? 0) + 1 }));
  const seedId = useId();
  const weatherId = useId();
  const saved = engine.savePointInfo;
  const fingerprint = engine.fingerprint();

  const onChange = (field: WorldFormField, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateWorldForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      setInvalidNonce((n) => n + 1);
      setPending(null);
      return;
    }
    setErrors({});
    setPending('create');
  };

  const run = (area: Area, action: () => void, done: string) => {
    try {
      action();
      setMessage(area, done);
    } catch (error) {
      setMessage(
        area,
        `That did not work: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    setPending(null);
  };

  const createWorld = () => {
    const result = validateWorldForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      setInvalidNonce((n) => n + 1);
      setPending(null);
      return;
    }
    run(
      'create',
      () => {
        engine.create({ seed: result.seed, config: result.config });
        onWorldReplaced();
      },
      `New world "${result.seed}" generated with ${formatInteger(Number(values.population))} people.`,
    );
  };

  return (
    <div className="world-panel" data-testid="world-panel">
      <Section title="World fingerprint" aside={`tick ${formatInteger(engine.tick)}`}>
        <p className="fingerprint" data-testid="fingerprint">
          <code>{fingerprint}</code>
        </p>
        <p className="muted small">
          A hash of the complete world state. The same seed and settings always give the same
          fingerprint at the same hour, on any device. Seed <code>demo-1</code> with 100 people
          reads <code>cc32f723…</code> at tick 24.
        </p>
      </Section>

      <Section title="Save point" aside="in memory">
        <p className="muted small">
          {saved
            ? `Saved at tick ${formatInteger(saved.tick)} (${formatCalendar(engine.calendarAt(saved.tick))}), fingerprint ${saved.hash.slice(0, 8)}…`
            : 'No save point yet. Save one, run on, then come back to it and watch the same future replay.'}
        </p>
        {pending === 'restore' && saved ? (
          <ConfirmBar
            message={`Go back to tick ${formatInteger(saved.tick)}? Everything after it is discarded.`}
            confirmLabel="Restore"
            onConfirm={() =>
              run(
                'save',
                () => {
                  engine.restore();
                  onWorldReplaced();
                },
                `Restored tick ${formatInteger(saved.tick)}; the fingerprint matches the save point.`,
              )
            }
            onCancel={() => setPending(null)}
          />
        ) : (
          <div className="row gap-s wrap">
            <button
              type="button"
              className="btn"
              disabled={engine.halted !== null}
              onClick={() => {
                const point = engine.savePoint();
                if (point) setMessage('save', `Saved tick ${formatInteger(point.tick)} in memory.`);
                setPending(null);
              }}
              data-testid="save-point"
            >
              {saved ? 'Replace save point' : 'Save point'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!saved}
              onClick={() => setPending('restore')}
              data-testid="restore-point"
            >
              Restore save point
            </button>
          </div>
        )}
        <ActionMessage message={message} area="save" />
      </Section>

      <Section title="Reset">
        {pending === 'reset' ? (
          <ConfirmBar
            message="Return this world to tick 0 with the same seed and settings? The save point is kept."
            confirmLabel="Reset to genesis"
            danger
            onConfirm={() =>
              run(
                'reset',
                () => {
                  engine.resetToGenesis();
                  onWorldReplaced();
                },
                'Back at genesis, tick 0.',
              )
            }
            onCancel={() => setPending(null)}
          />
        ) : (
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={() => setPending('reset')}
            data-testid="reset"
          >
            Reset to genesis
          </button>
        )}
        <ActionMessage message={message} area="reset" />
      </Section>

      <Section title="New world">
        <form ref={formRef} className="world-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor={seedId} className="field-label">
              Seed
            </label>
            <input
              id={seedId}
              type="text"
              value={values.seed}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={errors.seed ? true : undefined}
              aria-describedby={`${seedId}-hint${errors.seed ? ` ${seedId}-error` : ''}`}
              onChange={(e) => onChange('seed', e.target.value)}
              data-testid="world-seed"
            />
            <span id={`${seedId}-hint`} className="field-hint">
              Letters, digits, “.”, “_” and “-”. The same seed gives the same world.
            </span>
            {errors.seed && (
              <span id={`${seedId}-error`} className="field-error">
                {errors.seed}
              </span>
            )}
          </div>
          <NumberField
            field="population"
            label="Population"
            hint={`${FORM_BOUNDS.population.min}–${formatInteger(DEMO_MAX_POPULATION)} people. The engine allows more; the browser demo is capped to stay smooth on phones.`}
            values={values}
            errors={errors}
            onChange={onChange}
          />
          <NumberField
            field="daysPerSeason"
            label="Days per season"
            hint={`${FORM_BOUNDS.daysPerSeason.min}–${FORM_BOUNDS.daysPerSeason.max}. A year has four seasons; one tick is one hour.`}
            values={values}
            errors={errors}
            onChange={onChange}
          />
          <div className="field-checkbox">
            <input
              id={weatherId}
              type="checkbox"
              checked={values.stochasticWeather}
              onChange={(e) => setValues((v) => ({ ...v, stochasticWeather: e.target.checked }))}
            />
            <label htmlFor={weatherId}>Stochastic weather</label>
            <span className="field-hint">
              Off: always clear, temperature follows the seasonal baseline.
            </span>
          </div>
          {pending === 'create' ? (
            <ConfirmBar
              message="Replace the current world? Its history and save point are discarded."
              confirmLabel="Generate world"
              onConfirm={createWorld}
              onCancel={() => setPending(null)}
            />
          ) : (
            <div>
              <button type="submit" className="btn btn-primary" data-testid="world-create">
                Generate new world
              </button>
            </div>
          )}
          <ActionMessage message={message} area="create" />
        </form>
      </Section>

      <Section title="About this demo">
        <div className="prose">
          <p>
            This runs entirely in your browser: the real simulation engine and the real map, with no
            server and no database. Nothing is saved; reloading the page starts over.
          </p>
          <p>
            <strong>What Phase 1 simulates:</strong> people sleep, stay home or walk the roads to
            plazas and parks depending on the hour, the weather, their energy and their personality;
            weather, temperature and seasons; ageing and life stages.
          </p>
          <p>
            <strong>Not yet:</strong> an economy. Money exists only as the endowments handed out at
            genesis; there are no jobs, trade, prices, laws or disasters, and no births or deaths.
            The full app, with its server, adds saved history, snapshots, data exports and separate
            operator and viewer access.
          </p>
        </div>
      </Section>
    </div>
  );
}
