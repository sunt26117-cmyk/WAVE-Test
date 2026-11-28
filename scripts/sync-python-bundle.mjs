import fs from 'node:fs';
import path from 'node:path';

const PYTHON_DIR = path.resolve('src/modules/focDyno/python');
const OUTPUT_FILE = path.resolve('src/modules/focDyno/pythonBundle.generated.ts');

const MANIFEST = [
  'requirements.txt',
  'motor_physics.py',
  'dyno_calibrator.py',
  'thermal_exporter.py',
  'dynamic_pmsm.py',
  'app.py',
];

function buildGeneratedSource() {
  const entries = MANIFEST.map((name) => {
    const filePath = path.join(PYTHON_DIR, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing Python source file: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    return `  { name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} },`;
  });

  return [
    '// AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.',
    '// Edit source files in src/modules/focDyno/python/ and run `npm run sync:python`.',
    '',
    'export interface PythonBundleFile {',
    '  name: string;',
    '  content: string;',
    '}',
    '',
    'export const PYTHON_BUNDLE_FILES: PythonBundleFile[] = [',
    ...entries,
    '];',
    '',
  ].join('\n');
}

const isCheckMode = process.argv.includes('--check');
const generated = buildGeneratedSource();

if (isCheckMode) {
  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error(`Generated bundle missing: ${OUTPUT_FILE}. Run "npm run sync:python".`);
    process.exit(1);
  }
  const current = fs.readFileSync(OUTPUT_FILE, 'utf8').replace(/\r\n/g, '\n');
  if (current !== generated) {
    console.error(
      'src/modules/focDyno/pythonBundle.generated.ts is out of sync with src/modules/focDyno/python/*.py.\n' +
        'Run "npm run sync:python" to regenerate it.'
    );
    process.exit(1);
  }
  console.log('Python bundle is in sync with src/modules/focDyno/python/ (6 files).');
} else {
  fs.writeFileSync(OUTPUT_FILE, generated, 'utf8');
  console.log(`Synced ${MANIFEST.length} files from src/modules/focDyno/python/ -> src/modules/focDyno/pythonBundle.generated.ts`);
}
