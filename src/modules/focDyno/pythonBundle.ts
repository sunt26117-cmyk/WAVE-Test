/**
 * Standalone Python + Streamlit FOC DynoLab V2 export bundle.
 *
 * Single source of truth for Python code lives in `src/modules/focDyno/python/*.py`.
 * Edit those `.py` files directly and run `npm run sync:python` (auto-run before builds)
 * to regenerate `./pythonBundle.generated.ts`.
 */
import JSZip from 'jszip';
import { PYTHON_BUNDLE_FILES, type PythonBundleFile } from './pythonBundle.generated';

export type { PythonBundleFile };
export { PYTHON_BUNDLE_FILES };

export async function downloadPythonBundleZip(): Promise<void> {
  const zip = new JSZip();
  for (const file of PYTHON_BUNDLE_FILES) {
    zip.file(file.name, file.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bldc_foc_dyno_v2_python.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
