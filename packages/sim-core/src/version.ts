/** Version of the simulation rules. Bumped whenever a rule change alters results. */
export const ENGINE_VERSION = '0.1.0';

/**
 * Version of the serialised WorldState layout. States with a different version are
 * rejected on restore rather than silently reinterpreted.
 */
export const STATE_SCHEMA_VERSION = 1;
