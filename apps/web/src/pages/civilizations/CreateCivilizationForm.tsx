import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, fieldIssues } from '../../api/client';
import { useCreateCivilization } from '../../api/queries';
import { ErrorMessage } from '../../components/Feedback';
import { useToast } from '../../components/Toasts';
import {
  FIELD_BOUNDS,
  NUMERIC_FIELDS,
  initialFormValues,
  normalizeIssuePath,
  toRequest,
  validateRequest,
  type CreateFormValues,
  type FieldErrors,
  type NumericFieldPath,
} from '../../lib/config-form';
import { formatCents } from '../../lib/format';

/*
 * Genesis form: name, optional seed, population and every SimulationConfig parameter
 * (behind an "Advanced parameters" disclosure). Validated with the shared schema
 * before sending; server validation errors are mapped back onto the fields.
 */

function NumberField({
  path,
  label,
  hint,
  step,
  value,
  error,
  onChange,
}: {
  path: NumericFieldPath;
  label: string;
  hint: string;
  step?: number;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const bounds = FIELD_BOUNDS[path];
  const range =
    bounds.min !== undefined && bounds.max !== undefined
      ? ` Range ${bounds.min}–${bounds.max}.`
      : '';
  const isMoney = path === 'initialWealth.meanCents';
  const cents = Number(value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={`config.${path}`}
        type="number"
        inputMode={bounds.integer ? 'numeric' : 'decimal'}
        min={bounds.min}
        max={bounds.max}
        step={step ?? (bounds.integer ? 1 : 'any')}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${errorId} ${hintId}` : hintId}
        data-testid={`field-${path}`}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={hintId} className="field-hint">
        {hint}
        {range}
        {isMoney && value.trim() !== '' && Number.isFinite(cents) && ` = ${formatCents(cents)}`}
      </span>
      {error && (
        <span id={errorId} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function CreateCivilizationForm() {
  const [values, setValues] = useState<CreateFormValues>(initialFormValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useCreateCivilization();
  const navigate = useNavigate();
  const toast = useToast();
  const nameId = useId();
  const seedId = useId();
  const weatherId = useId();

  const setNumber = (path: NumericFieldPath, v: string) =>
    setValues((s) => ({ ...s, numbers: { ...s.numbers, [path]: v } }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const request = toRequest(values);
    const clientErrors = validateRequest(request);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;
    create.mutate(request, {
      onSuccess: (detail) => {
        toast.success('Civilization created', `"${detail.name}" with seed ${detail.seed}.`);
        void navigate(`/civ/${detail.id}`);
      },
      onError: (error) => {
        const issues = fieldIssues(error);
        if (issues.length > 0) {
          const next: FieldErrors = {};
          for (const issue of issues)
            next[normalizeIssuePath(issue.path) || 'form'] ??= issue.message;
          setErrors(next);
        } else if (error instanceof ApiError && error.code === 'CONFLICT') {
          setErrors({ name: error.message });
        }
      },
    });
  };

  const populationField = NUMERIC_FIELDS[0];
  const advancedFields = NUMERIC_FIELDS.slice(1);
  const errorFor = (path: string) => errors[`config.${path}`];
  const configLevelError = errors['config'] ?? errors['form'];

  return (
    <form className="panel create-form" onSubmit={submit} noValidate aria-labelledby="create-title">
      <div className="panel-header">
        <h2 id="create-title" className="panel-title">
          New civilization
        </h2>
      </div>
      <div className="panel-body stack gap-m">
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            name="name"
            required
            maxLength={80}
            autoComplete="off"
            value={values.name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${nameId}-error` : undefined}
            data-testid="field-name"
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
          {errors.name && (
            <span id={`${nameId}-error`} className="field-error">
              {errors.name}
            </span>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={seedId}>
            Seed <span className="muted">(optional)</span>
          </label>
          <input
            id={seedId}
            name="seed"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            className="mono"
            value={values.seed}
            aria-invalid={errors.seed ? true : undefined}
            aria-describedby={`${seedId}-hint`}
            data-testid="field-seed"
            onChange={(e) => setValues((s) => ({ ...s, seed: e.target.value }))}
          />
          <span id={`${seedId}-hint`} className="field-hint">
            Leave empty and the server picks a random seed (recorded and shown afterwards). The same
            seed and parameters always produce the same world.
          </span>
          {errors.seed && <span className="field-error">{errors.seed}</span>}
        </div>
        <NumberField
          {...populationField}
          value={values.numbers[populationField.path]}
          error={errorFor(populationField.path)}
          onChange={(v) => setNumber(populationField.path, v)}
        />
        <details className="disclosure" data-testid="advanced-parameters">
          <summary>Advanced parameters</summary>
          <div className="form-grid">
            {advancedFields.map((f) => (
              <NumberField
                key={f.path}
                path={f.path}
                label={f.label}
                hint={f.hint}
                step={'step' in f ? f.step : undefined}
                value={values.numbers[f.path]}
                error={errorFor(f.path)}
                onChange={(v) => setNumber(f.path, v)}
              />
            ))}
            <div className="field field-checkbox">
              <input
                id={weatherId}
                type="checkbox"
                checked={values.stochasticWeather}
                aria-describedby={`${weatherId}-hint`}
                onChange={(e) => setValues((s) => ({ ...s, stochasticWeather: e.target.checked }))}
              />
              <label htmlFor={weatherId} className="field-label">
                Stochastic weather
              </label>
              <span id={`${weatherId}-hint`} className="field-hint">
                When off, weather stays clear and temperature follows the seasonal baseline, so the
                run is a pure function of its initial state.
              </span>
            </div>
          </div>
        </details>
        {configLevelError && <div className="field-error">{configLevelError}</div>}
        {create.isError && fieldIssues(create.error).length === 0 && (
          <ErrorMessage error={create.error} title="Could not create the civilization" />
        )}
        <div className="row gap-s">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={create.isPending}
            data-testid="create-submit"
          >
            {create.isPending ? 'Generating world…' : 'Create civilization'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={create.isPending}
            onClick={() => {
              setValues(initialFormValues());
              setErrors({});
            }}
          >
            Restore defaults
          </button>
        </div>
      </div>
    </form>
  );
}
