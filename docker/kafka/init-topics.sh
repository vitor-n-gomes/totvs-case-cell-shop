#!/bin/sh
set -eu
for topic in casecellshop.demo.message-created.v1 order.checkout.initiated order.checkout.initiated.dlq; do
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:19092 --create --if-not-exists --topic "$topic" --partitions 3 --replication-factor 1
done
