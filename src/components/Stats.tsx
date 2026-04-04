import { motion } from "motion/react";

const stats = [
  { label: "Assets Under Management", value: "$4.2B+" },
  { label: "Annualized Returns", value: "32.4%" },
  { label: "Proprietary Models", value: "140+" },
  { label: "Years of Excellence", value: "12" },
];

export default function Stats() {
  return (
    <section className="py-24 border-y border-white/5 bg-white/[0.02]">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12 md:gap-8">
          {stats.map((stat, index) => (
            <motion.div 
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              viewport={{ once: true }}
              className="text-center md:text-left"
            >
              <div className="text-3xl md:text-4xl font-serif italic mb-2">{stat.value}</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">{stat.label}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
