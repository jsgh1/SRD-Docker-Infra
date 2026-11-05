<?php

declare(strict_types=1);

$host = getenv('P47_REVERB_HOST') ?: 'chat-reverb';
$appKey = getenv('REVERB_APP_KEY');
if (!$appKey) {
    fwrite(STDERR, "REVERB_APP_KEY is required for the synthetic P47 WebSocket probe.\n");
    exit(2);
}

$socket = @stream_socket_client("tcp://{$host}:8080", $errno, $error, 10);
if (!$socket) {
    fwrite(STDERR, "Reverb probe could not connect inside the isolated Docker network: {$error} ({$errno}).\n");
    exit(1);
}
stream_set_timeout($socket, 20);

$key = base64_encode(random_bytes(16));
$request = "GET /app/{$appKey}?protocol=7&client=js&version=8.4.0&flash=false HTTP/1.1\r\n"
    . "Host: {$host}:8080\r\n"
    . "Upgrade: websocket\r\n"
    . "Connection: Upgrade\r\n"
    . "Sec-WebSocket-Key: {$key}\r\n"
    . "Sec-WebSocket-Version: 13\r\n"
    . "Origin: http://localhost\r\n\r\n";
if (fwrite($socket, $request) !== strlen($request)) {
    fwrite(STDERR, "Reverb probe could not write the WebSocket upgrade request.\n");
    exit(1);
}

$headers = '';
while (($line = fgets($socket)) !== false) {
    $headers .= $line;
    if ($line === "\r\n") {
        break;
    }
}
$expectedAccept = base64_encode(sha1($key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
if (!preg_match('/^HTTP\/1\.[01] 101\b/m', $headers)
    || !preg_match('/^Sec-WebSocket-Accept:\s*(.+)$/mi', $headers, $acceptMatch)
    || trim($acceptMatch[1]) !== $expectedAccept) {
    fwrite(STDERR, "Reverb did not return a valid RFC 6455 upgrade response.\n");
    exit(1);
}

function readExact($stream, int $length): string
{
    $data = '';
    while (strlen($data) < $length) {
        $chunk = fread($stream, $length - strlen($data));
        if ($chunk === false || $chunk === '') {
            $meta = stream_get_meta_data($stream);
            throw new RuntimeException($meta['timed_out'] ? 'WebSocket read timed out.' : 'WebSocket closed before Pusher pong.');
        }
        $data .= $chunk;
    }
    return $data;
}

function writeFrame($stream, int $opcode, string $payload): void
{
    $length = strlen($payload);
    if ($length < 126) {
        $header = pack('C2', 0x80 | $opcode, 0x80 | $length);
    } elseif ($length <= 65535) {
        $header = pack('C2n', 0x80 | $opcode, 0xfe, $length);
    } else {
        throw new RuntimeException('Unexpected oversized client WebSocket frame.');
    }
    $mask = random_bytes(4);
    $masked = '';
    for ($i = 0; $i < $length; $i++) {
        $masked .= $payload[$i] ^ $mask[$i % 4];
    }
    $frame = $header . $mask . $masked;
    if (fwrite($stream, $frame) !== strlen($frame)) {
        throw new RuntimeException('WebSocket frame write was incomplete.');
    }
}

try {
    $pingSent = false;
    while (true) {
        $head = readExact($socket, 2);
        $opcode = ord($head[0]) & 0x0f;
        $masked = (ord($head[1]) & 0x80) !== 0;
        $length = ord($head[1]) & 0x7f;
        if ($length === 126) {
            $length = unpack('nlength', readExact($socket, 2))['length'];
        } elseif ($length === 127) {
            $wide = unpack('Nhigh/Nlow', readExact($socket, 8));
            if ($wide['high'] !== 0 || $wide['low'] > 65536) {
                throw new RuntimeException('Unexpected oversized server WebSocket frame.');
            }
            $length = $wide['low'];
        }
        $mask = $masked ? readExact($socket, 4) : '';
        $payload = readExact($socket, $length);
        if ($masked) {
            for ($i = 0; $i < $length; $i++) {
                $payload[$i] = $payload[$i] ^ $mask[$i % 4];
            }
        }
        if ($opcode === 8) {
            throw new RuntimeException('Reverb closed before Pusher pong.');
        }
        if ($opcode === 9) {
            writeFrame($socket, 10, $payload);
            continue;
        }
        if ($opcode !== 1) {
            continue;
        }
        $message = json_decode($payload, true);
        $event = is_array($message) ? ($message['event'] ?? null) : null;
        if ($event === 'pusher:connection_established' && !$pingSent) {
            $pingSent = true;
            writeFrame($socket, 1, json_encode(['event' => 'pusher:ping', 'data' => new stdClass()], JSON_THROW_ON_ERROR));
        } elseif ($event === 'pusher:pong') {
            fwrite(STDOUT, "PASS: Pusher WebSocket upgrade and application ping/pong inside the isolated Docker network.\n");
            exit(0);
        }
    }
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
} finally {
    fclose($socket);
}
