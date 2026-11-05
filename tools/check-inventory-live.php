<?php
// Synthetic signed HTTP/MySQL concurrency check. Run before inventory-scheduler starts.
require '/app/services/inventory/vendor/autoload.php';
$app = require '/app/services/inventory/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

$org = (string) Str::uuid();
$context = ['organization_id' => $org, 'user_id' => (string) Str::uuid(), 'role' => 'treasurer', 'name' => 'Tesorera sintética'];
$key = getenv('INTERNAL_KEY');
if (!is_string($key) || strlen($key) < 32) throw new RuntimeException('Missing internal key');
$call = function (string $path, array $data) use ($context, $key): array {
    $uri = '/internal/v1/'.$path;
    $body = json_encode($data, JSON_THROW_ON_ERROR);
    $claims = ['iss' => 'gateway', 'aud' => 'inventory', 'iat' => time(), 'exp' => time() + 30,
        'nonce' => (string) Str::uuid(), 'method' => 'POST', 'path' => $uri,
        'hash' => hash('sha256', $body), 'context' => $context];
    $encoded = base64_encode(json_encode($claims, JSON_THROW_ON_ERROR));
    $response = file_get_contents('http://127.0.0.1:8000'.$uri, false, stream_context_create(['http' => [
        'method' => 'POST', 'timeout' => 15, 'ignore_errors' => true,
        'header' => "Content-Type: application/json\r\nAccept: application/json\r\nX-SRD-Context: ".$encoded.'.'.hash_hmac('sha256', $encoded, $key),
        'content' => $body,
    ]]));
    if ($response === false || !preg_match('/^HTTP\/\S+ (\d+)/', $http_response_header[0] ?? '', $match)) {
        throw new RuntimeException('Inventory HTTP unavailable');
    }
    return [(int) $match[1], json_decode($response, true, 512, JSON_THROW_ON_ERROR)];
};
$paths = [];
try {
    [$status, $created] = $call('assets', [
        'code' => 'TEST-'.strtoupper(substr(str_replace('-', '', $org), 0, 10)),
        'type' => 'movable', 'name' => 'Sillas sintéticas', 'category' => 'Mobiliario',
        'unit' => 'unidad', 'location' => 'Salón', 'condition' => 'Bueno',
        'quantity' => 34, 'idempotency_key' => (string) Str::uuid(),
    ]);
    if ($status !== 200 || ($created['data']['asset']['quantity'] ?? null) !== 34) throw new RuntimeException('Create failed');
    $id = $created['data']['asset']['id'];
    for ($i = 0; $i < 2; $i++) {
        $path = sys_get_temp_dir().'/inventory-'.(string) Str::uuid().'.json';
        $paths[] = $path;
        $pid = pcntl_fork();
        if ($pid === -1) throw new RuntimeException('Fork failed');
        if ($pid === 0) {
            try {
                $result = $call('assets/'.$id.'/movements', [
                    'type' => 'out', 'quantity' => 20, 'reason' => 'Salida sintética '.($i + 1),
                    'idempotency_key' => (string) Str::uuid(),
                ]);
                file_put_contents($path, json_encode($result, JSON_THROW_ON_ERROR));
                exit(0);
            } catch (Throwable $error) {
                file_put_contents($path, json_encode(['error' => $error->getMessage()], JSON_THROW_ON_ERROR));
                exit(1);
            }
        }
    }
    while (pcntl_wait($childStatus) > 0) {}
    $statuses = array_map(fn($path) => json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR)[0] ?? null, $paths);
    sort($statuses);
    if ($statuses !== [200, 422]) throw new RuntimeException('Concurrent stock was not serialized: '.json_encode($statuses));
    $quantity = (int) DB::table('assets')->where('id', $id)->value('quantity');
    $sum = (int) DB::table('asset_movements')->where('asset_id', $id)->sum('delta');
    if ($quantity !== 14 || $sum !== 14) throw new RuntimeException('Stock mismatch');
    if (DB::table('outbox_events')->where('organization_id', $org)->where('action', 'inventory.movement_rejected')->count() !== 1) {
        throw new RuntimeException('Rejected movement was not audited');
    }
    echo "PASS inventory signed HTTP/MySQL concurrent withdrawal, nonnegative stock and rejection audit\n";
} finally {
    foreach ($paths as $path) if (is_file($path)) unlink($path);
    DB::table('outbox_events')->where('organization_id', $org)->delete();
    DB::table('asset_movements')->where('organization_id', $org)->delete();
    DB::table('assets')->where('organization_id', $org)->delete();
}
