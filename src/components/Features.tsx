import { motion } from "motion/react";
import { Shield, Zap, BarChart3, Globe } from "lucide-react";

const features = [
  {
    icon: <Zap className="w-6 h-6" />,
    title: "High-Frequency Execution",
    description: "Sub-millisecond latency execution across global markets, optimized by AI-driven order routing."
  },
  {
    icon: <BarChart3 className="w-6 h-6" />,
    title: "Predictive Modeling",
    description: "Advanced neural networks trained on decades of multi-asset data to forecast short-term volatility."
  },
  {
    icon: <Shield className="w-6 h-6" />,
    title: "Risk Containment",
    description: "Automated risk management protocols that adapt in real-time to shifting market regimes."
  },
  {
    icon: <Globe className="w-6 h-6" />,
    title: "Global Arbitrage",
    description: "Identifying cross-border inefficiencies through deep learning analysis of geopolitical signals."
  }
];

export default function Features() {
  return (
    <section className="py-32 relative">
      <div className="container mx-auto px-6">
        <div className="max-w-3xl mb-24">
          <h2 className="text-4xl md:text-5xl font-serif italic mb-8">The Architecture of Alpha</h2>
          <p className="text-lg text-white/50 font-light leading-relaxed">
            We don't follow trends. We decode the underlying mathematics of the market. 
            Our infrastructure is built for stability, speed, and absolute performance.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-px bg-white/10 border border-white/10">
          {features.map((feature, index) => (
            <motion.div 
              key={feature.title}
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: index * 0.1 }}
              viewport={{ once: true }}
              className="bg-black p-12 hover:bg-white/[0.02] transition-colors group"
            >
              <div className="mb-6 text-white/40 group-hover:text-white transition-colors">
                {feature.icon}
              </div>
              <h3 className="text-xl font-medium mb-4 tracking-tight">{feature.title}</h3>
              <p className="text-white/40 font-light leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
