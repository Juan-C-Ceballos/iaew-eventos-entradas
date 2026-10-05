const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

function archivosMarkdown(directorio) {
  return fs.readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return entrada.name === 'node_modules' || entrada.name.startsWith('.') ? [] : archivosMarkdown(ruta);
    return entrada.name.endsWith('.md') ? [ruta] : [];
  });
}

test('el índice de ADRs lista todos los archivos adr-NNNN-*.md', () => {
  const indice = fs.readFileSync(path.join(raiz, 'docs/adr/README.md'), 'utf8');
  const archivos = fs.readdirSync(path.join(raiz, 'docs/adr')).filter((nombre) => /^adr-\d{4}-.+\.md$/.test(nombre));
  assert.ok(archivos.length >= 11, 'faltan ADRs');
  for (const archivo of archivos) assert.ok(indice.includes(`(${archivo})`), `docs/adr/README.md no lista ${archivo}`);
});

test('los enlaces relativos de README.md y docs/ apuntan a archivos que existen', () => {
  const rotos = [];
  for (const archivo of [path.join(raiz, 'README.md'), ...archivosMarkdown(path.join(raiz, 'docs'))]) {
    const contenido = fs.readFileSync(archivo, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, destino] of contenido.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(destino)) continue;
      const sinAncla = destino.split('#')[0];
      if (!sinAncla) continue;
      if (!fs.existsSync(path.resolve(path.dirname(archivo), sinAncla))) rotos.push(`${path.relative(raiz, archivo)} → ${destino}`);
    }
  }
  assert.deepEqual(rotos, []);
});

test('los diagramas de secuencia de Mermaid no usan ";" en los mensajes', () => {
  // En sequenceDiagram el ";" separa sentencias (como un salto de línea): un mensaje que lo
  // contenga corta el parser y GitHub muestra "Unable to render rich display".
  const problemas = [];
  for (const archivo of [path.join(raiz, 'README.md'), ...archivosMarkdown(path.join(raiz, 'docs'))]) {
    const contenido = fs.readFileSync(archivo, 'utf8');
    for (const [, diagrama] of contenido.matchAll(/```mermaid\n(sequenceDiagram[\s\S]*?)```/g)) {
      diagrama.split('\n').forEach((linea, i) => {
        if (linea.includes(';')) problemas.push(`${path.relative(raiz, archivo)} (línea ${i + 1} del diagrama): ${linea.trim()}`);
      });
    }
  }
  assert.deepEqual(problemas, []);
});
