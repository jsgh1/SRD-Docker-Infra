<?php

$host = 'smtp.gmail.com';
$port = 587;
$socket = @stream_socket_client("tcp://{$host}:{$port}", $errorCode, $errorText, 8);
if ($socket === false) {
    fwrite(STDERR, "SMTP_TCP_FAIL {$errorCode} {$errorText}\n");
    exit(1);
}
fclose($socket);
echo "SMTP_TCP_OK\n";
