<?php
// Inside the disposable Files container. No real records or photographs.
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (!extension_loaded('gd') || !extension_loaded('pdo_mysql')) throw new RuntimeException('Missing image/database extension');
foreach (['file_quotas', 'person_photos', 'asset_photos', 'file_garbage', 'outbox_events'] as $table) {
    if (!Illuminate\Support\Facades\Schema::hasTable($table)) throw new RuntimeException('Missing photo table');
    if (Illuminate\Support\Facades\DB::table($table)->count() !== 0) throw new RuntimeException('Probe unexpectedly persisted data');
}
echo "PASS GD, MySQL and four empty tables\n";
$id = '11111111-1111-4111-8111-111111111111';
$path = '/internal/v1/persons/'.$id.'/photos';
foreach (['gateway' => 503, 'records' => 403, 'unsigned' => 401] as $issuer => $expected) {
    $body = '[]';
    $claims = ['iss' => $issuer, 'aud' => 'files', 'iat' => time(), 'exp' => time()+30,
        'nonce' => bin2hex(random_bytes(16)), 'method' => 'GET', 'path' => $path, 'hash' => hash('sha256', $body),
        'context' => ['organization_id' => $id, 'user_id' => $id, 'session_id' => $id, 'role' => 'admin']];
    $encoded = base64_encode(json_encode($claims));
    $header = "Content-Type: application/json\r\nAccept: application/json\r\n";
    if ($issuer !== 'unsigned') $header .= 'X-SRD-Context: '.$encoded.'.'.hash_hmac('sha256', $encoded, getenv('INTERNAL_KEY'));
    $result = file_get_contents('http://127.0.0.1:8000'.$path, false, stream_context_create(['http' => ['method' => 'GET', 'header' => $header, 'content' => $body, 'ignore_errors' => true, 'timeout' => 20]]));
    if (!preg_match('/^HTTP\/\S+ (\d+)/', $http_response_header[0] ?? '', $matches) || (int)$matches[1] !== $expected) throw new RuntimeException('Unexpected HTTP response for '.$issuer);
    if ((json_decode($result, true)['error']['code'] ?? '') !== 'HTTP_'.$expected) throw new RuntimeException('Unexpected error body');
    echo "PASS $issuer: $expected\n";
}
$gate = new SrdFiles\ImageGate(config('photos.quarantine'), new SrdFiles\ClamdScanner(config('photos.scanner')));
$image = imagecreatetruecolor(2, 2); ob_start(); imagepng($image); $png = ob_get_clean(); imagedestroy($image);
try {
    $gate->prepare('synthetic.png', $png);
    throw new RuntimeException('Unavailable scanner must reject');
} catch (SrdFiles\ScannerUnavailable) {
    if (glob(config('photos.quarantine').'/*') !== []) throw new RuntimeException('Quarantine was not cleaned');
    echo "PASS unavailable real scanner fails closed and cleans quarantine\n";
}
