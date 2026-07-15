

本文為英文版的機器翻譯版本，如內容有任何歧義或不一致之處，概以英文版為準。

# Architecture
<a name="architecture"></a>

## 傳統周邊區域架構
<a name="traditional-perimeter-zone-architecture"></a>

在許多組織中，面向網際網路的應用程式會在與內部部署環境分隔的周邊區域中「封閉」。如下圖所示，應用程式流量透過防火牆路由至周邊區域，周邊區域中的應用程式透過另一個防火牆與其他應用程式和網路分隔。

![傳統周邊區域架構](http://docs.aws.amazon.com/zh_tw/prescriptive-guidance/latest/migration-perimeter-zone-apps-network-firewall/images/traditional_perimeter_zone_architecture.png)


## 基於 Network Firewall 的周邊區域架構
<a name="perimeter-zone-applications-network-firewall"></a>

下圖顯示了 AWS 雲端中周邊區域應用程式的網路架構範例：



![中的周邊區域應用程式的架構 AWS 雲端](http://docs.aws.amazon.com/zh_tw/prescriptive-guidance/latest/migration-perimeter-zone-apps-network-firewall/images/perimeter_zone_architecture_network_firewall.png)


在上面的網路架構範例中，應用程式透過下列機制受到保護：
+ 來自 Amazon CloudFront 的 Web 應用程式防火牆可作為抵禦應用程式端點攻擊的第一層保護。
+ 在公有子網路中， AWS Network Firewall 會檢查路由到應用程式端點的所有流量 （透過 Application Load Balancer)。為了確保所有流量都經過 Network Firewall 的端點，您必須更新路由表，如圖所示。

建議您透過網路防火牆，將所有輸出流量從應用程式路由至 AWS Transit Gateway 。這有助於在將流量路由至受保護網路之前將帳戶中的所有流量送交審核。

## 流量資料流程
<a name="traffic-data-flow"></a>

下圖顯示流量透過以 Network Firewall 為基礎的周邊區域架構的資料流程：



![基於 Network Firewall 的周邊區域架構的流量資料流程](http://docs.aws.amazon.com/zh_tw/prescriptive-guidance/latest/migration-perimeter-zone-apps-network-firewall/images/traffic_data_flow.png)


該圖顯示以下工作流程：

1. 使用者透過 Amazon CloudFront 透過網際網路存取您的應用程式。您可以使用 CloudFront 中的預設 DNS 或 [Amazon Route 53 ](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html)支援的 DNS。

1. 網際網路閘道路由邏輯會透過路由表組態，透過防火牆的網路界面，將 Application Load Balancer 的所有傳入請求轉送至 Network Firewall。本指南[基於 Network Firewall 的周邊區域架構](#perimeter-zone-applications-network-firewall)一節圖表中的**路由表 IGW** 對此進行了說明。

1. 根據 Network Firewall 中的規則，接收到的流量將封鎖或轉送。您也可以建立傳送提醒的規則。Network Firewall 對傳入或傳出流量完全透明，且不執行網路地址轉譯。

1. 通過防火牆的傳入流量到達 Application Load Balancer，而不會發生變更。Application Load Balancer 再次回應時，會將請求 (基於路由表邏輯) 轉送至網路防火牆。本指南的[基於 Network Firewall 的周邊區域架構](#perimeter-zone-applications-network-firewall)一節圖表中的**路由表端點 A** 和**路由表端點 B** 對此進行了說明。

## 網路元件
<a name="network-components"></a>

我們建議您在為 AWS 雲端設計的周邊區域架構中包含下列元件：
+ [Amazon CloudFront 和 AWS WAF](https://docs.aws.amazon.com/waf/latest/developerguide/what-is-aws-waf.html)** **– CloudFront 與 搭配使用 AWS WAF ，以提供分散式拒絕服務 (DDoS) 保護、Web 應用程式防火牆、IP 允許清單 （如果需要） 和內容交付。CloudFront 必須僅使用 SSL 憑證來接受 HTTPS 連線 (傳輸中加密)。
+ [網際網路閘道](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html) – 使用網際網路閘道將 VPC 連接至網際網路。根據路由表 （請參閱本指南[中以 Network Firewall 為基礎的周邊區域架構](#perimeter-zone-applications-network-firewall)圖表中的**路由表 IGW** 一節），所有預期用於端點子網路 （即負載平衡器） 的傳入流量會先透過其彈性網路界面路由至 Network Firewall。本指南[基於 Network Firewall 的周邊區域架構](#perimeter-zone-applications-network-firewall)一節圖表中的 **eni-id-sec1** 和 **eni-id-sec2** 對此進行了說明。
+ [Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html) – Network Firewall 是一種自動擴展防火牆，可為輸入和輸出流量提供防火牆和監控功能。您可以透過 Gateway Load Balancer 端點類型將 Network Firewall 附接至 VPC。將端點放在面向大眾的網路中，以允許進出網際網路閘道的流量路由至 Network Firewall。本指南[基於 Network Firewall 的周邊區域架構](#perimeter-zone-applications-network-firewall)一節圖表中的**路由表安全**對此進行了說明。
+ [端點子網路和 Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) – 使用面向網際網路的 Application Load Balancer，讓您的應用程式可透過網際網路存取。您必須擁有僅透過 Network Firewall 向網際網路公開的受保護子網路。此路由由路由表組態定義。路由表只允許一個來源為 **0.0.0.0/0** 的路由，因此每個子網路和防火牆網路介面組合都必須有兩個路由表。本指南的[基於 Network Firewall 的周邊區域架構](#perimeter-zone-applications-network-firewall)一節圖表中的**路由表端點 A** 和**路由表端點 B** 對此進行了說明。若要在傳輸中進行加密，您必須使用 SSL 啟用負載平衡器。
+ [傳輸閘道](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html) – 傳輸閘道可讓您存取其他網路，例如內部部署網路或其他 VPC。在本指南中介紹的網路架構中，傳輸閘道會透過端點子網路中的網路界面公開。此實作可確保傳輸閘道接收來自 Web 應用程式 （即私有子網路） 的流量。
+ [應用程式子網路](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html) – 這是應用程式在 Amazon Elastic Compute Cloud (Amazon EC2) 執行個體上執行的私有子網路。
+ [NAT 閘道](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) – 本指南中的架構範例不包含 NAT 閘道。如果您的網路架構需要 NAT 閘道，則建議您在每個子網路中新增 NAT 閘道。在這種情況下，我們也建議您應用程式的路由表將目的地 **0.0.0.0/0** 映射至 NAT 閘道的網路界面。

## 遷移周邊區域應用程式
<a name="migrating-perimeter-zone-applications"></a>

探索程序對於成功遷移至關重要。當您使用探索工具時，例如 AWS Application Discovery Service，我們建議您確保工具可以同時安裝在周邊網路和內部網路上。我們還建議您確認可以正確擷取資料流。最佳實務是使用手動探索程序來補充工具所完成的自動探索。例如，在手動探索程序中，您可以採訪應用程式團隊，以更深入了解應用程式的技術需求和考量事項。手動程序還可以協助您識別可能影響 AWS 雲端中應用程式設計的邊緣情況。

作為探索程序的一部分，我們建議您識別下列項目：

1. 不受信任網路和周邊網路中的用戶端之間的網路相依性

1. 周邊網路與安全網路中應用程式元件之間的相依性

1. 透過 VPN 直接與安全網路建立的任何第三方連線

1. 任何現有的 Web 應用程式防火牆

1. 任何現有的入侵偵測系統和入侵防禦系統及其各自的偵測規則 (如果可能)