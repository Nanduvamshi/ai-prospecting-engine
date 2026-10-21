/**
 * No-op stand-in for the `server-only` marker package.
 *
 * The real package throws on import outside a React Server Component build,
 * which is exactly what makes it useful in production and useless in a test
 * runner. The package ships its own empty module under the `react-server`
 * export condition for the same reason; jest resolves conditions differently,
 * so it gets pointed here instead.
 */
export {};
