// One-time mechanical extraction. Deliberately refuses to overwrite extracted code.
import fs from 'node:fs';
const base = 'services/records/app';
if (fs.existsSync(`${base}/Application/PersonService.php`)) throw new Error('Already extracted');
let source = fs.readFileSync(`${base}/Http/Controllers/PersonController.php`, 'utf8');
const validation = source.slice(source.indexOf('    private function validateData'), source.indexOf('    public function save'));
source = source.replace(validation, '');
source = source.replace('namespace App\\Http\\Controllers;', 'namespace App\\Application;');
source = source.replace('use Illuminate\\Http\\Request;', 'use App\\Persistence\\PersonRepository;');
source = source.replace('final class PersonController', 'final class PersonService');
source = source.replace("    private function query(array $p)\n", "    public function __construct(private PersonRepository $people) {}\n\n    private function query(array $p)\n");
source = source.replace("return DB::table('persons')->where('organization_id', $p['organization_id']);", "return $this->people->forOrganization($p['organization_id']);");
const filtersStart = source.indexOf('    private function filters');
const filtersEnd = source.indexOf('    public function index');
source = source.slice(0, filtersStart) + `    private function filters($q, array $filters): void
    {
        if (isset($filters['q']) && $filters['q'] !== '') {
            $needle = '%'.addcslashes($filters['q'], '%_\\\\').'%';
            $q->where(fn ($q) => $q->where('first_names', 'like', $needle)->orWhere('last_names', 'like', $needle)->orWhere('document_number', 'like', $needle));
        }
        foreach (['status', 'zone', 'affiliated'] as $field) {
            if (isset($filters[$field]) && $filters[$field] !== '') $q->where($field, $filters[$field]);
        }
    }

` + source.slice(filtersEnd);
source = source.replace("public function index(Request $r): array\n    {\n        $p = Access::require('persons.read');", 'public function index(array $p, array $filters): array\n    {');
source = source.replace('$this->filters($q, $r);', '$this->filters($q, $filters);').replace("$r->input('page_size', 10)", "($filters['page_size'] ?? 10)").replace("$r->input('page', 1)", "($filters['page'] ?? 1)");
source = source.replace('public function show(string $id)', 'public function show(array $p, string $id)').replace("$this->detail(Access::require('persons.read'), $id)", '$this->detail($p, $id)');
source = source.replace("public function lookup(Request $r): array\n    {\n        $p = Access::require('persons.read');\n        $d = $r->validate(['document_type' => 'required|in:RC,TI,CC,CE,NIT', 'document_number' => 'required|string|max:30']);", 'public function lookup(array $p, array $d): array\n    {');
const saveStart = source.indexOf('    public function save');
const txStart = source.indexOf('        return DB::transaction', saveStart);
source = source.slice(0, saveStart) + '    public function save(array $p, array $d, ?string $id = null): array\n    {\n' + source.slice(txStart);
source = source.replace("public function delete(Request $r, string $id): array\n    {\n        $p = Access::require('persons.delete');\n        $d = $r->validate(['confirmed' => 'required|accepted', 'version' => 'required|integer|min:1']);", 'public function delete(array $p, array $d, string $id): array\n    {');
source = source.replace("public function dashboard(): array\n    {\n        $p = Access::require('dashboard.read');", 'public function dashboard(array $p): array\n    {');
if (/\$r\b|Request/.test(source)) throw new Error('HTTP dependency not removed');
for (const dir of ['Application', 'Persistence', 'Http/Validation']) fs.mkdirSync(`${base}/${dir}`, { recursive: true });
fs.writeFileSync(`${base}/Application/PersonService.php`, source);
fs.writeFileSync(`${base}/Http/Validation/PersonInput.php`, `<?php
namespace App\\Http\\Validation;
use Illuminate\\Http\\Request;
final class PersonInput
{
${validation.replace('private function validateData(Request $r)', 'public static function save(Request $r)')}
    public static function filters(Request $r): array
    {
        return $r->validate(['q' => 'nullable|string|max:120', 'status' => 'nullable|in:pending,complete', 'zone' => 'nullable|in:rural,urban', 'affiliated' => 'nullable|boolean', 'page' => 'nullable|integer|min:1', 'page_size' => 'nullable|in:10,25,50']);
    }
}
`);
fs.writeFileSync(`${base}/Persistence/PersonRepository.php`, `<?php
namespace App\\Persistence;
use Illuminate\\Database\\Query\\Builder;
use Illuminate\\Support\\Facades\\DB;
final class PersonRepository
{
    public function forOrganization(string $organizationId): Builder
    {
        return DB::table('persons')->where('organization_id', $organizationId);
    }
}
`);
fs.writeFileSync(`${base}/Http/Controllers/PersonController.php`, `<?php
namespace App\\Http\\Controllers;
use App\\Application\\PersonService;
use App\\Http\\Validation\\PersonInput;
use Illuminate\\Http\\Request;
use Srd\\Access;
final class PersonController
{
    public function __construct(private PersonService $service) {}
    public function index(Request $r): array
    {
        $p = Access::require('persons.read');
        return $this->service->index($p, PersonInput::filters($r));
    }
    public function show(string $id): array
    {
        return $this->service->show(Access::require('persons.read'), $id);
    }
    public function lookup(Request $r): array
    {
        $p = Access::require('persons.read');
        $d = $r->validate(['document_type' => 'required|in:RC,TI,CC,CE,NIT', 'document_number' => 'required|string|max:30']);
        return $this->service->lookup($p, $d);
    }
    public function save(Request $r, ?string $id = null): array
    {
        $p = Access::require('persons.write');
        $d = PersonInput::save($r);
        if ($id) $r->validate(['version' => 'required|integer|min:1']);
        return $this->service->save($p, $d, $id);
    }
    public function delete(Request $r, string $id): array
    {
        $p = Access::require('persons.delete');
        $d = $r->validate(['confirmed' => 'required|accepted', 'version' => 'required|integer|min:1']);
        return $this->service->delete($p, $d, $id);
    }
    public function dashboard(): array
    {
        return $this->service->dashboard(Access::require('dashboard.read'));
    }
}
`);
console.log('Records: extracted HTTP, validation, use case and scoped query.');
