const assert = require('assert');
const logic = require('../storefront/progressbar.js');

function test(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (err) {
    console.error('FAIL', name, err.message);
    process.exitCode = 1;
  }
}

test('toAmount parses cents integer string', () => {
  assert.strictEqual(logic.toAmount('3000000'), 30000);
});

test('toAmount parses currency-like string', () => {
  assert.strictEqual(logic.toAmount('30.000,00'), 30000);
});

test('parseSubtotalFromText parses ARS text', () => {
  assert.strictEqual(logic.parseSubtotalFromText('$30.000,00'), 30000);
});

test('buildLocalEnvioResult returns missing message', () => {
  const cfg = {
    enable_envio_rule: true,
    envio_scope: 'all',
    envio_min_amount: 50000,
    envio_text_prefix: 'Te falta',
    envio_text_suffix: 'para envio',
    envio_bar_color: '#123456',
  };
  const r = logic.buildLocalEnvioResult(30000, cfg);
  assert.ok(r);
  assert.strictEqual(r.color, '#123456');
  assert.ok(r.message.includes('Te falta'));
  assert.ok(r.message.includes('para envio'));
});

test('buildLocalCuotasResult reaches 100 when threshold reached', () => {
  const cfg = {
    enable_cuotas_rule: true,
    cuotas_scope: 'all',
    cuotas_threshold_amount: 10000,
    cuotas_text_reached: 'Cuotas activadas',
  };
  const r = logic.buildLocalCuotasResult(12000, cfg);
  assert.ok(r);
  assert.strictEqual(r.pct, 100);
  assert.ok(r.message.includes('Cuotas activadas'));
});

test('requiresRemoteEvaluation false for all-scope simple rules', () => {
  const cfg = {
    enable_envio_rule: true,
    envio_scope: 'all',
    enable_cuotas_rule: true,
    cuotas_scope: 'all',
    enable_regalo_rule: false,
  };
  assert.strictEqual(logic.requiresRemoteEvaluation(cfg), false);
});

test('requiresRemoteEvaluation true for category scope', () => {
  const cfg = {
    enable_envio_rule: true,
    envio_scope: 'category',
    enable_cuotas_rule: false,
    enable_regalo_rule: false,
  };
  assert.strictEqual(logic.requiresRemoteEvaluation(cfg), true);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
