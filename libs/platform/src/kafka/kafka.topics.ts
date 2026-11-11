export const kafkaTopics = {
    Dlq: process.env.KAFKA_CASE_CELL_SHOP_DLQ_TOPIC || 'preprod-case-cell-shop-events-dlq',
    CaseCellShopEvents: process.env.KAFKA_CASE_CELL_SHOP_CHECKOUT_TOPIC || 'preprod-case-cell-shop-events',
}